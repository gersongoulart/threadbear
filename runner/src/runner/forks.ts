// Native conversation forks. Build the copy off-list and publish it only
// after history, media, workspace and provider state all exist.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Runner, ThreadState } from '../runner.ts';
import { newRuntime } from './runtime.ts';
import type { RunnerPart } from './part.ts';
import type { ThreadRecord } from '../store.ts';
import { cutOut } from '../store.ts';
import { ErrorCode, RpcError, type PersistedEvent, type ThreadSummary } from '../protocol.ts';
import { forkWorkspaceInfo, makeForkWorkspace, type ForkWorkspaceInfo } from '../fork-workspace.ts';
import { findWorktreePatch } from '../patches.ts';
import { worktreeInstructions } from '../worktrees.ts';
import { cutSafely } from '../safe-cut.ts';
import { runningSession } from '../cli-session.ts';

export type ForkOptions = { workspace: 'same' | 'worktree'; requestId: string; throughTurnId?: string };
export type ForkInfo = { available: boolean; reason?: string; workspace?: ForkWorkspaceInfo };
type PendingFork = { source: string; workspace: ForkOptions['workspace']; throughTurnId?: string; promise: Promise<{ thread: ThreadSummary }> };
const pendingForks = new WeakMap<Runner, Map<string, PendingFork>>();

function unavailable(runner: Runner, st: ThreadState): string | undefined {
  const { rec, rt } = st;
  if (runner.boxThread !== undefined) return 'A virtual runner can only host its assigned thread.';
  if (!runner.adapters[rec.provider]?.forkSession) return 'This provider does not support conversation forks.';
  if (rt.holds?.size || rt.forking || rt.editing || rt.moving || rt.turn || rt.tasks.length || rt.runningActions?.size || rt.hooksRunning || rt.cleaning || rt.preparing || rt.wakeTimer || rec.subagents?.some((a) => a.status === 'running') || rec.queue.length || rec.pendingApprovals.length || rt.approvals.size || ['starting', 'running', 'waiting'].includes(rec.status)) return 'Wait for this thread to finish and become idle before forking.';
  if (runner.worktreeCleanup(st)) return 'This shared worktree is being cleaned up. Try again when it is idle.';
  if (rec.copied || rec.sample || !rec.sessionUsed || !rec.nativeSessionId || rec.handoff || rec.resumeAt || !rec.lastTurnCompletedSeq) return 'This thread has no complete saved native session to fork.';
  if (runner.leavesRemovedWorktree(rec)) return 'This thread’s worktree has been removed. Resume it before forking.';
  return undefined;
}

function forkBoundary(runner: Runner, rec: ThreadRecord, throughTurnId?: string) {
  if (throughTurnId === undefined) return undefined;
  if (typeof throughTurnId !== 'string' || !throughTurnId || throughTurnId.length > 256) throw new RpcError(ErrorCode.badParams, 'throughTurnId must identify a completed reply boundary.');
  let end: PersistedEvent | undefined;
  for (let seq = 1; seq <= rec.lastSeq; seq += 500) {
    for (const event of runner.store.log(rec.id).read(seq, Math.min(seq + 499, rec.lastSeq))) {
      if (event.type === 'turn.completed' && event.turnId === throughTurnId && !cutOut(rec, event.seq)) end = event;
    }
  }
  if (!end) throw new RpcError(ErrorCode.badParams, 'That boundary is not a visible completed reply.');
  const throughSeq = end.seq;
  let userMessageId: string | undefined;
  let anchor: { assistantItemId?: string; toolCallId?: string; toolResultId?: string } = {};
  let legacyTotal = 0, legacyPrefix = 0;
  for (let seq = 1; seq <= rec.lastSeq; seq += 500) {
    for (const event of runner.store.log(rec.id).read(seq, Math.min(seq + 499, rec.lastSeq))) {
      if (cutOut(rec, event.seq)) continue;
      if (event.type === 'turn.completed' && typeof event.costUsd === 'number') {
        legacyTotal += event.costUsd;
        if (event.seq <= throughSeq) legacyPrefix += event.costUsd;
      }
      if (event.seq > throughSeq || event.turnId !== end.turnId) continue;
      if (event.type === 'user.message' && !userMessageId) userMessageId = event.turnId;
      // end_turn's synthesized display text has no native message identity.
      // Its preceding tool result is the real inclusive session endpoint.
      if (event.type === 'assistant.text' && !/\.(summary|reply)$/.test(event.itemId)) anchor = { assistantItemId: event.itemId };
      if (event.type === 'tool.call') anchor = { toolCallId: event.itemId };
      if (event.type === 'tool.result') anchor = { toolResultId: event.itemId };
    }
  }
  if (!userMessageId) throw new RpcError(ErrorCode.badParams, 'This reply has no saved message boundary in its native session.');
  let costTotal = end.type === 'turn.completed' ? end.sessionCostTotal : undefined;
  if (costTotal === undefined) {
    // Older histories can be reconstructed only while their complete cost
    // ledger matches the current native cumulative total. Resets, rewinds,
    // missing copied costs and provider changes otherwise make it ambiguous.
    if (rec.provider === 'claude' && Math.abs(legacyTotal - (rec.sessionCostTotal ?? 0)) > 0.00001) throw new RpcError(ErrorCode.badParams, 'This older reply has no reliable saved cost boundary. Fork a newer reply instead.');
    costTotal = Math.round(legacyPrefix * 1e6) / 1e6;
  }
  return { seq: throughSeq, costTotal, native: { userMessageId, ...anchor } };
}

function copyFiles(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (file) => {
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('A thread attachment is not a regular file; it cannot be copied independently.');
      return true;
    },
  });
}

function replacePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.split(`${from}${path.sep}`).join(`${to}${path.sep}`);
  if (Array.isArray(value)) return value.map((v) => replacePaths(v, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replacePaths(v, from, to)]));
  return value;
}

const HISTORY = new Set(['user.message', 'assistant.text', 'reasoning', 'tool.call', 'tool.result', 'edit.diff', 'action.run', 'turn.started', 'turn.completed', 'system.note', 'error']);

function keepDuringDrain(runner: Runner, threadId: string): void {
  // A drain can begin while an awaited native copy is running.
  runner.draining?.keep.add(threadId);
}

function copiedHistory(runner: Runner, rec: ThreadRecord, childId: string, destinationCwd: string, idMap: Record<string, string> = {}, throughSeq = rec.lastSeq): PersistedEvent[] {
  const from = runner.store.threadDir(rec.id);
  const to = runner.store.threadDir(childId);
  const kept: PersistedEvent[] = [];
  for (let seq = 1; seq <= throughSeq; seq += 500) {
    for (const original of runner.store.log(rec.id).read(seq, Math.min(seq + 499, throughSeq))) {
      if (cutOut(rec, original.seq) || !HISTORY.has(original.type)) continue;
      const event = replacePaths(original, from, to) as PersistedEvent;
      event.threadId = childId;
      event.seq = kept.length + 1;
      if (event.turnId) event.turnId = idMap[event.turnId] ?? event.turnId;
      if (event.type === 'edit.diff' && destinationCwd !== rec.cwd) {
        const relative = path.relative(rec.cwd, path.resolve(rec.cwd, event.path));
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue;
        event.path = path.join(destinationCwd, relative);
      }
      if (event.type === 'turn.completed') {
        // A historical card must never ask again, or count as new spend.
        // Keep its cumulative baseline for nested message forks; it is not billed.
        delete event.asks;
        delete event.next;
        delete event.review;
        delete event.usage;
        delete event.costUsd;
        delete event.needsFrom;
        event.needs = 'nothing';
      }
      if (event.type === 'user.message') {
        delete event.editOf;
        delete event.scheduleId;
        delete event.reviewId;
        delete event.reviewResponse;
        delete event.answers;
      }
      kept.push(event);
    }
  }
  return kept;
}

export function forkIdentityText(rec: ThreadRecord): string | undefined {
  if (!rec.forkedFrom) return undefined;
  const parts = [
    `Note from Threadbear: this is an independent fork of thread ${rec.forkedFrom.threadId}. Your thread ID is ${rec.id}, and your current working folder is ${rec.cwd}. Earlier thread IDs and worktree instructions in the copied conversation describe the source. Use your current tools and environment for this fork.`,
  ];
  if (rec.worktree?.shared) parts.push('This folder and branch are shared with the source; this fork has no independent Land action.');
  else if (rec.worktree) parts.push(worktreeInstructions(rec.worktree));
  return parts.join('\n\n');
}

export const forksPart = {
  async forkInfo(this: Runner, threadId: string, throughTurnId?: string): Promise<ForkInfo> {
    const st = this.mustGet(threadId);
    const reason = unavailable(this, st);
    if (reason) return { available: false, reason };
    if (await this.lentFolder(st.rec)) return { available: false, reason: 'This thread’s folder was lent elsewhere. Resume it before forking.' };
    forkBoundary(this, st.rec, throughTurnId);
    const workspace = st.rec.confined ? undefined : await forkWorkspaceInfo(st.rec.cwd);
    return { available: true, ...(workspace ? { workspace } : {}) };
  },

  async forkThread(this: Runner, threadId: string, options: ForkOptions): Promise<{ thread: ThreadSummary }> {
    let pending = pendingForks.get(this);
    if (!pending) pendingForks.set(this, pending = new Map());
    const existing = pending.get(options.requestId);
    if (existing) {
      if (existing.source !== threadId || existing.workspace !== options.workspace || existing.throughTurnId !== options.throughTurnId) throw new RpcError(ErrorCode.badParams, 'That fork request ID is already being used with different options.');
      return existing.promise;
    }
    const promise = this.forkThreadNow(threadId, options);
    pending.set(options.requestId, { source: threadId, workspace: options.workspace, throughTurnId: options.throughTurnId, promise });
    try { return await promise; }
    finally {
      pending.delete(options.requestId);
      if (!pending.size) pendingForks.delete(this);
    }
  },

  async forkThreadNow(this: Runner, threadId: string, options: ForkOptions): Promise<{ thread: ThreadSummary }> {
    this.checkAccepting();
    if (this.draining) throw new RpcError(ErrorCode.busy, 'The runner is handing over; fork again in a moment.');
    if (!/^[a-f0-9-]{36}$/i.test(options.requestId)) throw new RpcError(ErrorCode.badParams, 'requestId must be a UUID.');
    if (!['same', 'worktree'].includes(options.workspace)) throw new RpcError(ErrorCode.badParams, 'workspace must be same or worktree.');
    // A successful retry does not depend on the source still existing or
    // on the original provider still being installed.
    const prior = [...this.threads.values()].find((s) => s.rec.forkedFrom?.requestId === options.requestId);
    if (prior) {
      if (prior.rec.forkedFrom!.threadId !== threadId || prior.rec.forkedFrom!.workspace !== options.workspace || prior.rec.forkedFrom!.throughTurnId !== options.throughTurnId) throw new RpcError(ErrorCode.badParams, 'That fork request ID was already used with different options.');
      return { thread: this.summary(prior) };
    }
    const source = this.mustGet(threadId);
    const { rec, rt } = source;
    if (await this.lentFolder(rec)) throw new RpcError(ErrorCode.busy, 'This thread’s folder was lent elsewhere. Resume it before forking.');
    const reason = unavailable(this, source);
    if (reason) throw new RpcError(ErrorCode.busy, reason);
    const through = forkBoundary(this, rec, options.throughTurnId);
    const account = this.accounts.get(rec.accountId);
    if (!account) throw new RpcError(ErrorCode.accountNotFound, 'The source account is no longer available.');
    if (rec.confined && options.workspace === 'worktree') throw new RpcError(ErrorCode.badParams, 'A confined thread can only fork in its existing folder.');
    const adapter = this.adapters[rec.provider]!;
    const title = `${cutSafely(rec.title, 193)} (fork)`;
    rt.forking = true;
    const childId = crypto.randomUUID();
    const stage = path.join(path.dirname(this.store.threadDir(childId)), `.fork-${childId}`);
    let workspace: Awaited<ReturnType<typeof makeForkWorkspace>> | undefined;
    let native: Awaited<ReturnType<NonNullable<typeof adapter.forkSession>>> | undefined;
    let published = false;
    try {
      // Flush native transcript writes and prevent unsolicited traffic while
      // the snapshot is read. No turn or background task is interrupted.
      if (runningSession(rt)) this.releaseSession(source);
      while (rt.closing) await rt.closing;
      if (options.workspace === 'worktree') {
        workspace = await makeForkWorkspace(rec.cwd, childId);
        // A copied branch is still the moved-in source's work. Hold its
        // new path before patch lookup/setup, and retain the mark so a
        // missing trust list cannot restore always-trust after restart.
        if (rec.worktree?.unvouched || this.patchTrust.isUnvouched?.(rec.cwd)) {
          workspace.worktree.unvouched = true;
          this.patchTrust.unvouch?.(workspace.worktree.path);
        }
      }
      const destinationCwd = workspace?.cwd ?? rec.cwd;
      fs.mkdirSync(stage, { recursive: true });
      copyFiles(this.store.mediaDir(rec.id), path.join(stage, 'media'));
      copyFiles(this.store.blobsDir(rec.id), path.join(stage, 'blobs'));
      native = await adapter.forkSession!({
        threadId: rec.id, account, cwd: rec.cwd, destinationCwd,
        sessionId: rec.nativeSessionId!, destinationThreadId: childId,
        title, through: through?.native,
        pathMap: { [this.store.threadDir(rec.id)]: this.store.threadDir(childId) },
      });
      if (!native.sessionId || native.sessionId === rec.nativeSessionId) throw new Error('The provider did not create an independent session.');
      await workspace?.assertUnchanged();
      const now = this.isoNow();
      const events = copiedHistory(this, rec, childId, destinationCwd, native.messageIdMap, through?.seq);
      events.push({ seq: events.length + 1, ts: now, threadId: childId, type: 'system.note', fork: true,
        text: `Forked from [${rec.title.replace(/[\[\]]/g, '')}](thread:${rec.id}). ${options.workspace === 'same' ? 'This conversation shares the original folder and files.' : 'This conversation has a separate worktree; untracked and ignored files were not copied.'}` });
      let childWorktree = workspace?.worktree;
      if (!childWorktree && rec.worktree && !rec.worktree.removedAt) childWorktree = { ...rec.worktree, shared: true };
      const child: ThreadRecord = {
        id: childId, title, titleSet: true,
        cwd: destinationCwd, accountId: rec.accountId, provider: rec.provider,
        permissionMode: rec.permissionMode, ...(rec.confined ? { confined: true } : {}),
        ...(rec.poolId ? { poolId: rec.poolId } : {}),
        ...(rec.model ? { model: rec.model } : {}), ...(rec.effort ? { effort: rec.effort } : {}),
        status: 'idle', createdAt: now, updatedAt: now, lastActivityAt: now,
        preview: options.throughTurnId === undefined ? rec.preview : '', lastSeq: events.length, lastSeenSeq: events.length,
        lastTurnCompletedSeq: events.findLast((e) => e.type === 'turn.completed')?.seq ?? 0,
        nativeSessionId: native.sessionId, sessionUsed: true,
        sessionCostTotal: through?.costTotal ?? rec.sessionCostTotal ?? 0, costUsd: 0,
        queue: [], pendingApprovals: [],
        forkedFrom: { threadId, title: rec.title, seq: through?.seq ?? rec.lastSeq, requestId: options.requestId, workspace: options.workspace, ...(options.throughTurnId === undefined ? {} : { throughTurnId: options.throughTurnId }) },
        ...(childWorktree ? { worktree: childWorktree } : {}),
      };
      if (child.lastTurnCompletedSeq) child.needs = { seq: child.lastTurnCompletedSeq, needs: 'nothing' };
      fs.writeFileSync(path.join(stage, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      fs.writeFileSync(path.join(stage, 'thread.json'), JSON.stringify(child) + '\n', { mode: 0o600 });
      fs.renameSync(stage, this.store.threadDir(childId));
      const st: ThreadState = { rec: child, rt: newRuntime(this.clock.now()) };
      st.rt.forking = true;
      this.threads.set(childId, st);
      keepDuringDrain(this, childId);
      published = true;
      const projects = (rec.projects ?? []).map((p) => p.id).filter((id) => this.projects?.list({ archived: true }).some((p) => p.id === id));
      if (projects.length) this.projects!.changeMembership(childId, { add: projects, by: 'mike' });
      if (workspace) try {
        const patch = await findWorktreePatch(rec.cwd, this.panelsRoot, this.patchCache, undefined, this.patchTrust);
        if (patch) {
          workspace.worktree.patchFile = path.relative((await forkWorkspaceInfo(rec.cwd))!.root, patch.file);
          await this.setUpWorktree(st, { worktree: workspace.worktree, patchFile: path.join(workspace.worktree.path, workspace.worktree.patchFile) }, patch);
        }
      } catch (error) {
        // The conversation already exists. A setup failure is reported on
        // it, never as a failed fork that a retry might duplicate.
        this.emit(st, { type: 'system.note', text: `The fork was created, but its worktree setup failed: ${String(error)}` });
      }
      this.markDirty(st);
      this.store.save(child);
      this.notify({ method: 'thread.updated', params: { thread: this.summary(st) } });
      return { thread: this.summary(st) };
    } catch (error) {
      if (!published) {
        await native?.cleanup?.().catch((e: unknown) => this.log.warn('could not remove failed fork session', { error: String(e) }));
        await workspace?.cleanup().catch((e: unknown) => this.log.warn('could not remove failed fork workspace', { error: String(e) }));
        fs.rmSync(stage, { recursive: true, force: true });
      }
      throw new RpcError(ErrorCode.other, `Couldn't fork this conversation: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rt.forking = false;
      const child = this.threads.get(childId);
      if (child) child.rt.forking = false;
      if (this.draining) this.queueHandoverCheck();
    }
  },
};

export type ForksPart = RunnerPart<typeof forksPart>;

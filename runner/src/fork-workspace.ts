// Fork workspaces copy the source checkout's revision and tracked dirty
// bytes. No stash, commit or index update is needed in the source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { untrustedGit } from './safe-git.ts';
import type { WorktreeRecord } from './worktrees.ts';

export type ForkWorkspaceInfo = { root: string; head: string; untracked: string[] };

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await untrustedGit(cwd, args, { env: { GIT_OPTIONAL_LOCKS: '0' } });
  if (!r.ok) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout;
}

export async function forkWorkspaceInfo(cwd: string): Promise<ForkWorkspaceInfo | undefined> {
  let root: string;
  try { root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { return undefined; }
  let head: string;
  try { head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch { return undefined; }
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  return { root, head, untracked };
}

async function snapshot(root: string): Promise<{ head: string; diff: string; index: string }> {
  if ((await git(root, ['ls-files', '--unmerged', '-z'])).trim()) throw new Error('Resolve the merge conflicts before forking into a worktree.');
  // A checkout with submodules cannot be reproduced just by applying a
  // patch. Refuse it instead of presenting an apparently complete copy.
  if ((await git(root, ['ls-files', '--stage'])).split('\n').some((line) => line.startsWith('160000 '))) throw new Error('Worktree forks do not yet copy submodules.');
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  const indexFile = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  const index = crypto.createHash('sha256').update(fs.readFileSync(indexFile)).digest('hex');
  const diff = await git(root, ['diff', '--binary', '--full-index', '--no-textconv', 'HEAD', '--', '.']);
  return { head, diff, index };
}

export async function makeForkWorkspace(cwd: string, threadId: string): Promise<{
  cwd: string; worktree: WorktreeRecord; cleanup(): Promise<void>; assertUnchanged(): Promise<void>;
}> {
  if (!/^[a-f0-9-]{36}$/.test(threadId)) throw new Error('A fork needs a valid destination thread ID.');
  const info = await forkWorkspaceInfo(cwd);
  if (!info) throw new Error('A separate worktree requires a Git repository.');
  const { root } = info;
  const before = await snapshot(root);
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const mainCheckout = path.basename(common) === '.git' ? path.dirname(common) : root;
  const repo = path.basename(mainCheckout);
  const destination = path.join(path.dirname(mainCheckout), `${repo}-threads`, `fork-${threadId}`);
  const branch = `thread/${threadId.slice(0, 8)}`;
  if (fs.existsSync(destination)) throw new Error('The destination folder already exists.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-fork-'));
  let allocated = false;
  let branchAllocated = false;
  const cleanup = async () => {
    if (allocated) {
      await git(root, ['worktree', 'remove', '--force', destination]);
      allocated = false;
    }
    if (branchAllocated) {
      await git(root, ['branch', '-D', branch]);
      branchAllocated = false;
    }
  };
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Allocate the branch separately: worktree add can create a branch
    // before checkout fails. Ownership is explicit even on that failure.
    await git(root, ['branch', branch, before.head]);
    branchAllocated = true;
    await git(root, ['worktree', 'add', destination, branch]);
    allocated = true;
    if (before.diff) {
      const file = path.join(temp, 'changes.patch');
      fs.writeFileSync(file, before.diff, { mode: 0o600 });
      await git(destination, ['apply', '--binary', file]);
    }
    const destinationCwd = path.join(destination, path.relative(root, fs.realpathSync(cwd)));
    if (!fs.existsSync(destinationCwd) || !fs.statSync(destinationCwd).isDirectory()) throw new Error('The source subfolder has no tracked files in the new worktree.');
    const assertUnchanged = async () => {
      const after = await snapshot(root);
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('The source files or revision changed while forking. Try again once they are idle.');
    };
    await assertUnchanged();
    return {
      cwd: destinationCwd,
      worktree: { repo, mainCheckout, path: destination, branch, base: before.head },
      cleanup,
      assertUnchanged,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

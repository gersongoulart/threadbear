import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { CodexAdapter } from '../../src/adapters/codex/adapter.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import { projectDirName, sessionTranscriptPath } from '../../src/transcripts.ts';
import type { Account } from '../../src/protocol.ts';
import type { SessionSink } from '../../src/adapters/types.ts';
import { FakeCodex } from '../helpers/fake-app-server.ts';

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-native-fork-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'source'), destinationCwd = path.join(dir, 'child');
  fs.mkdirSync(cwd); fs.mkdirSync(destinationCwd);
  const account: Account = { id: 'claude-other', provider: 'claude', title: 'Other', configDir: path.join(dir, 'account'), defaultModel: 'haiku', models: [] };
  return { dir, cwd, destinationCwd, account, registry: new ProcessRegistry(dir, nullLogger) };
}

test('Claude native fork preserves context in the destination account and folder with UUID mapping', async (t) => {
  const f = fixture(t), id = crypto.randomUUID(), user = crypto.randomUUID(), assistant = crypto.randomUUID();
  const dir = path.join(f.account.configDir, 'projects', projectDirName(fs.realpathSync(f.cwd)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const common = { sessionId: id, cwd: f.cwd, timestamp: '2026-11-16T00:00:00.000Z', isSidechain: false };
  const original = [
    { ...common, type: 'user', uuid: user, parentUuid: null, message: { role: 'user', content: `Remember violet and ${path.join(f.dir, 'source-data', 'image.png')}.` } },
    { ...common, type: 'assistant', uuid: assistant, parentUuid: user, message: { role: 'assistant', content: [{ type: 'text', text: 'Violet remembered.' }] } },
  ];
  fs.writeFileSync(file, original.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const before = fs.readFileSync(file), inherited = process.env.CLAUDE_CONFIG_DIR;
  const adapter = new ClaudeAdapter({ claudePath: '/unused', registry: f.registry, log: nullLogger, queryFn: (() => { throw new Error('Fork must not start a model'); }) as never });
  const out = await adapter.forkSession({ ...f, threadId: 'source', sessionId: id, destinationThreadId: 'child', title: 'My fork', pathMap: { [path.join(f.dir, 'source-data')]: path.join(f.dir, 'child-data') } });
  assert.notEqual(out.sessionId, id);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, inherited);
  assert.deepEqual(fs.readFileSync(file), before);
  const child = sessionTranscriptPath(f.account.configDir, f.destinationCwd, out.sessionId);
  assert.ok(child, 'the fork must be independently resumable in its destination folder');
  const entries = fs.readFileSync(child, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  const copied = entries.filter((x) => x.type === 'user' || x.type === 'assistant');
  assert.equal(copied[0].message.content, `Remember violet and ${path.join(f.dir, 'child-data', 'image.png')}.`);
  assert.deepEqual(copied[1].message, original[1].message);
  assert.equal(copied[1].parentUuid, copied[0].uuid);
  assert.deepEqual(out.messageIdMap, { [user]: copied[0].uuid, [assistant]: copied[1].uuid });
  assert.ok(copied.every((x) => x.cwd === f.destinationCwd && x.sessionId === out.sessionId));
  assert.equal(entries.find((x) => x.type === 'custom-title').customTitle, 'My fork');
  fs.rmSync(file); assert.ok(fs.existsSync(child));
  await out.cleanup?.(); assert.equal(fs.existsSync(child), false);
});

test('Claude native fork refuses a missing source without an empty replacement', async (t) => {
  const f = fixture(t), adapter = new ClaudeAdapter({ claudePath: '/unused', registry: f.registry, log: nullLogger });
  await assert.rejects(adapter.forkSession({ ...f, threadId: 'source', sessionId: crypto.randomUUID(), destinationThreadId: 'child', title: 'Fork' }), /not found|missing/i);
});

test('Claude message fork cuts native history at the selected assistant message', async (t) => {
  const f = fixture(t), id = crypto.randomUUID(), user = crypto.randomUUID(), answer = crypto.randomUUID();
  const dir = path.join(f.account.configDir, 'projects', projectDirName(fs.realpathSync(f.cwd)));
  fs.mkdirSync(dir, { recursive: true });
  const common = { sessionId: id, cwd: f.cwd, isSidechain: false };
  const entries = [
    { ...common, type: 'user', uuid: user, parentUuid: null, message: { role: 'user', content: 'First question' } },
    { ...common, type: 'assistant', uuid: answer, parentUuid: user, message: { id: 'msg-first', role: 'assistant', content: [{ type: 'text', text: 'First answer' }] } },
    { ...common, type: 'user', uuid: crypto.randomUUID(), parentUuid: answer, message: { role: 'user', content: 'Later secret banana' } },
  ];
  const file = path.join(dir, `${id}.jsonl`), original = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, original);
  const adapter = new ClaudeAdapter({ claudePath: '/unused', registry: f.registry, log: nullLogger });
  const req = { ...f, threadId: 'source', sessionId: id, destinationThreadId: 'child', title: 'Fork', through: { userMessageId: user, assistantItemId: 'msg-first:0' } };
  const fork = await adapter.forkSession(req);
  const child = fs.readFileSync(sessionTranscriptPath(f.account.configDir, f.destinationCwd, fork.sessionId)!, 'utf8');
  assert.ok(child.includes('First answer'));
  assert.ok(!child.includes('Later secret banana'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await fork.cleanup?.();
  await assert.rejects(adapter.forkSession({ ...req, through: { userMessageId: user, assistantItemId: 'missing:0' } }), /boundary|message|session/i);
});

test('Codex message fork resolves a native turn and sends its inclusive boundary', async (t) => {
  const f = fixture(t), fake = await FakeCodex.create(); t.after(() => fake.close());
  const adapter = new CodexAdapter({ codexBinary: () => fake.bin, registry: f.registry, log: nullLogger });
  const pending = adapter.forkSession({ ...f, threadId: 'source', sessionId: 'native-source', destinationThreadId: 'child', title: 'Fork', through: { userMessageId: 'runner-first', assistantItemId: 'answer' } });
  const conn = await fake.next(); await conn.init();
  const list = await conn.request('thread/turns/list', 300);
  conn.respond(list.id, { data: [{ id: 'native-later', items: [{ type: 'userMessage', clientId: 'runner-later' }] }, { id: 'native-first', items: [{ type: 'userMessage', clientId: 'runner-first' }] }], nextCursor: null });
  const req = await conn.request('thread/fork');
  assert.equal(req.params.lastTurnId, 'native-first');
  conn.respond(req.id, result('native-child'));
  for (const method of ['thread/goal/clear', 'thread/name/set']) { const r = await conn.request(method); conn.respond(r.id, {}); }
  assert.equal((await pending).sessionId, 'native-child');
  await conn.closed;
});

test('Claude message fork keeps the native end_turn tool and result behind a synthesized reply', async (t) => {
  const f = fixture(t), id = crypto.randomUUID(), user = crypto.randomUUID(), tool = crypto.randomUUID(), resultId = crypto.randomUUID();
  const dir = path.join(f.account.configDir, 'projects', projectDirName(fs.realpathSync(f.cwd)));
  fs.mkdirSync(dir, { recursive: true });
  const common = { sessionId: id, cwd: f.cwd, isSidechain: false };
  const entries = [
    { ...common, type: 'user', uuid: user, parentUuid: null, message: { role: 'user', content: 'First' } },
    { ...common, type: 'assistant', uuid: tool, parentUuid: user, message: { id: 'msg-tool', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-end', name: 'end_turn', input: { summary: 'First summary' } }] } },
    { ...common, type: 'user', uuid: resultId, parentUuid: tool, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-end', content: 'ok' }] } },
    { ...common, type: 'user', uuid: crypto.randomUUID(), parentUuid: resultId, message: { role: 'user', content: 'Later secret banana' } },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const adapter = new ClaudeAdapter({ claudePath: '/unused', registry: f.registry, log: nullLogger });
  const fork = await adapter.forkSession({ ...f, threadId: 'source', sessionId: id, destinationThreadId: 'child', title: 'Fork', through: { userMessageId: user, toolResultId: 'toolu-end' } });
  const child = fs.readFileSync(sessionTranscriptPath(f.account.configDir, f.destinationCwd, fork.sessionId)!, 'utf8');
  assert.ok(child.includes('tool_use'));
  assert.ok(child.includes('tool_result'));
  assert.ok(!child.includes('Later secret banana'));
  await fork.cleanup?.();
});

function result(id: string) { return { thread: { id, turns: [] }, model: 'gpt-6-luna', cwd: '/work', reasoningEffort: 'low' }; }
const sink: SessionSink = { output() {}, exited() {}, async requestApproval() { return { decision: 'allow' }; }, async requestQuestion() { return { answers: null }; } };

test('Codex native fork uses isolated account process and resumed persisted tools route only to child', async (t) => {
  const f = fixture(t), fake = await FakeCodex.create(); t.after(() => fake.close());
  const account = { ...f.account, provider: 'codex' as const, id: 'codex-other' }, called: string[] = [];
  const deps = { codexBinary: () => fake.bin, registry: f.registry, log: nullLogger, toolsFor: (id: string) => [{ name: 'identify', description: 'Identify thread', inputSchema: {}, annotations: { readOnlyHint: true }, handler: async () => { called.push(id); return { content: [{ type: 'text', text: id }] }; } }] };
  const adapter = new CodexAdapter(deps);
  const pending = adapter.forkSession({ ...f, account, threadId: 'source', sessionId: 'native-source', destinationThreadId: 'child', title: 'Fork' });
  const conn = await fake.next(); await conn.init();
  assert.equal(conn.hello.env.CODEX_HOME, account.configDir);
  const req = await conn.request('thread/fork');
  assert.equal(req.params.threadId, 'native-source'); assert.equal(req.params.cwd, f.destinationCwd);
  assert.equal((req.params.config as Record<string, unknown>)['shell_environment_policy.set.THREADBEAR_THREAD_ID'], 'child');
  assert.equal(req.params.deferGoalContinuation, true);
  assert.equal((req.params.config as Record<string, unknown>)['shell_environment_policy.set.THREADBEAR_THREAD_KEY'], '');
  conn.respond(req.id, result('native-child'));
  const clear = await conn.request('thread/goal/clear'); assert.equal(clear.params.threadId, 'native-child'); conn.respond(clear.id, {});
  const name = await conn.request('thread/name/set'); assert.deepEqual(name.params, { threadId: 'native-child', name: 'Fork' }); conn.respond(name.id, {});
  const fork = await pending; assert.equal(fork.sessionId, 'native-child'); assert.equal(typeof fork.cleanup, 'function'); await conn.closed;
  assert.equal(conn.sent('turn/start').length, 0);
  // A new adapter represents restart; persisted tool schemas contain no handlers.
  const resumed = new CodexAdapter(deps).start({ threadId: 'child', cwd: f.destinationCwd, account, permissionMode: 'ask', sessionId: 'native-child', resume: true, mediaDir: f.dir, blobsDir: f.dir, tmpDir: f.dir, env: { THREADBEAR_THREAD_ID: 'child', THREADBEAR_THREAD_KEY: 'child-key' } }, sink);
  t.after(() => resumed.end({ hard: true }));
  const next = await fake.next(); await next.init();
  const resume = await next.request('thread/resume');
  assert.equal((resume.params.config as Record<string, unknown>)['shell_environment_policy.set.THREADBEAR_THREAD_ID'], 'child');
  assert.equal((resume.params.config as Record<string, unknown>)['shell_environment_policy.set.THREADBEAR_THREAD_KEY'], 'child-key');
  next.respond(resume.id, result('native-child'));
  const response = await next.serverRequest('item/tool/call', { threadId: 'native-child', turnId: 'turn', callId: 'call', namespace: 'threadbear', tool: 'identify', arguments: {} });
  assert.deepEqual(called, ['child']); assert.equal((response.result as { success: boolean }).success, true);
  await resumed.end();
  const clean = fork.cleanup!();
  const cleanupConn = await fake.next(); await cleanupConn.init();
  const archive = await cleanupConn.request('thread/archive'); assert.equal(archive.params.threadId, 'native-child'); cleanupConn.respond(archive.id, {});
  const remove = await cleanupConn.request('thread/delete'); assert.equal(remove.params.threadId, 'native-child'); cleanupConn.respond(remove.id, {});
  await clean; await cleanupConn.closed;
});

test('Codex native fork rejects a reused source ID and closes process', async (t) => {
  const f = fixture(t), fake = await FakeCodex.create(); t.after(() => fake.close());
  const adapter = new CodexAdapter({ codexBinary: () => fake.bin, registry: f.registry, log: nullLogger });
  const pending = adapter.forkSession({ ...f, threadId: 'source', sessionId: 'native-source', destinationThreadId: 'child', title: 'Fork' });
  const rejected = assert.rejects(pending, /new|fresh|different/i);
  const conn = await fake.next(); await conn.init();
  const req = await conn.request('thread/fork'); conn.respond(req.id, result('native-source'));
  await rejected; await conn.closed;
});

test('Codex native fork rewrites only its new persisted media paths after process closes', async (t) => {
  const f = fixture(t), fake = await FakeCodex.create(); t.after(() => fake.close());
  const sessions = path.join(f.account.configDir, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  const sourceFile = path.join(sessions, 'source.jsonl'), childFile = path.join(sessions, 'child.jsonl');
  const oldPath = path.join(f.dir, 'source-data'), newPath = path.join(f.dir, 'child-data');
  const line = JSON.stringify({ type: 'response_item', payload: { content: [{ type: 'local_image', path: `${oldPath}/picture.png` }], text: `${oldPath}-sibling/file` } }) + '\n';
  fs.writeFileSync(sourceFile, line);
  const adapter = new CodexAdapter({ codexBinary: () => fake.bin, registry: f.registry, log: nullLogger });
  const pending = adapter.forkSession({ ...f, threadId: 'source', sessionId: 'native-source', destinationThreadId: 'child', title: 'Fork', pathMap: { [oldPath]: newPath } });
  const conn = await fake.next(); await conn.init();
  const req = await conn.request('thread/fork');
  fs.writeFileSync(childFile, line);
  conn.respond(req.id, { thread: { id: 'native-child', path: childFile } });
  const clear = await conn.request('thread/goal/clear'); conn.respond(clear.id, {});
  const name = await conn.request('thread/name/set'); conn.respond(name.id, {});
  await pending; await conn.closed;
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), line);
  const history = JSON.parse(fs.readFileSync(childFile, 'utf8'));
  assert.equal(history.payload.content[0].path, `${newPath}/picture.png`);
  assert.equal(history.payload.text, `${oldPath}-sibling/file`);
  fs.rmSync(sourceFile);
  assert.ok(fs.existsSync(childFile));
});

test('Codex native fork failure before a new ID closes without touching source', async (t) => {
  const f = fixture(t), fake = await FakeCodex.create(); t.after(() => fake.close());
  const adapter = new CodexAdapter({ codexBinary: () => fake.bin, registry: f.registry, log: nullLogger });
  const pending = adapter.forkSession({ ...f, threadId: 'source', sessionId: 'missing', destinationThreadId: 'child', title: 'Fork' });
  const rejected = assert.rejects(pending, /not found/);
  const conn = await fake.next(); await conn.init();
  const req = await conn.request('thread/fork'); conn.fail(req.id, -32602, 'Source session not found');
  await rejected; await conn.closed;
  assert.equal(conn.sent('thread/delete').length, 0);
  assert.equal(conn.sent('thread/archive').length, 0);
  assert.equal(conn.sent('turn/start').length, 0);
});

test('Codex native fork rolls back only its new child when goal clearing fails', async (t) => {
  const f = fixture(t), fake = await FakeCodex.create(); t.after(() => fake.close());
  const adapter = new CodexAdapter({ codexBinary: () => fake.bin, registry: f.registry, log: nullLogger });
  const pending = adapter.forkSession({ ...f, threadId: 'source', sessionId: 'native-source', destinationThreadId: 'child', title: 'Fork' });
  const rejected = assert.rejects(pending, /goal clear failed/);
  const conn = await fake.next(); await conn.init();
  const req = await conn.request('thread/fork'); conn.respond(req.id, result('native-child'));
  const clear = await conn.request('thread/goal/clear'); conn.fail(clear.id, -32602, 'goal clear failed');
  const archive = await conn.request('thread/archive'); assert.equal(archive.params.threadId, 'native-child'); conn.respond(archive.id, {});
  const remove = await conn.request('thread/delete'); assert.equal(remove.params.threadId, 'native-child'); conn.respond(remove.id, {});
  await rejected; await conn.closed;
});

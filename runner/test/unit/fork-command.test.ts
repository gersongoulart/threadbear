import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCommand, parseCommand } from '../../src/slash-commands.ts';

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: /fork belongs to the desktop and never reaches a model or skill`, () => {
    for (const text of ['/fork', '/FORK', '/fork worktree']) {
      const plan = planCommand(provider, parseCommand(text)!, new Set(['fork']));
      assert.equal(plan.kind, 'note');
      if (plan.kind === 'note') assert.match(plan.text, /Fork….*thread menu/);
    }
  });
}

// Older desktops and phone/web sends must receive a note, never a native
// terminal fork command or a model-generated substitute.
import { FakeAccounts, makeHarness, tick, withCodex } from '../helpers/fakes.ts';
for (const accountId of ['claude-main', 'codex-main']) {
  test(`${accountId}: runner intercepts /fork without sending a second model input`, async () => {
    const h = makeHarness(undefined, {}, { accounts: new FakeAccounts(withCodex()) });
    const { thread } = h.runner.create({ text: 'hello', accountId });
    const session = (accountId === 'codex-main' ? h.codex : h.adapter).last;
    session.init();
    session.result();
    h.runner.send(thread.id, '/fork');
    await tick();
    assert.equal(session.sent.length, 1);
    assert.match(h.events(thread.id).filter(e => e.type === 'system.note').at(-1)?.text ?? '', /Fork….*thread menu/);
  });
}

import { Given, Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { ThreadbearWorld } from '../support/world.ts';

Given('this conversation has a later reply', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'forkLater', params: { threadId: 'demo_reply_buttons' } });
  await this.until('later reply drawn', d => d.transcript.rows.some(r => r.text.includes('Later-only banana')));
});
When('I click the first reply\'s inline fork icon', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'scroll', to: 'top' });
  await this.app.do({ cmd: 'click', title: 'Fork from here' });
  await this.until('the message fork chooser', d => d.forkSheet?.canFork === true);
});
Then('the chooser is scoped to the first reply', async function (this: ThreadbearWorld) {
  assert.equal((await this.app.dump()).forkSheet?.throughTurnId, 'turn_1');
});
Then('the fork contains the first reply without the later reply', async function (this: ThreadbearWorld) {
  const rows = (await this.app.dump()).transcript.rows;
  assert.ok(rows.some(r => r.text.includes('Morning brief')));
  assert.ok(!rows.some(r => r.text.includes('Later-only banana')));
});

When('I open the fork chooser with the slash command', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'type', text: '/fork', replace: true });
  await this.app.do({ cmd: 'send' });
  await this.until('the fork preview', d => d.forkSheet?.canFork === true);
});
When('I open the fork chooser from the thread menu', async function (this: ThreadbearWorld) {
  const id = (await this.app.dump()).selection!.id;
  await this.app.do({ cmd: 'menu-popover', show: 'thread', id });
  await this.app.do({ cmd: 'menu-popover', click: 'Fork…' });
  await this.until('the fork preview', d => d.forkSheet?.canFork === true);
});
Then('the fork chooser offers shared files', async function (this: ThreadbearWorld) {
  const sheet = (await this.app.dump()).forkSheet;
  assert.equal(sheet?.workspace, 'same');
  assert.equal(sheet?.canFork, true);
});
When('I choose a separate worktree', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', title: 'New worktree' });
});
Then('the fork chooser names the excluded untracked files', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.equal(d.forkSheet?.workspace, 'worktree');
  assert.deepEqual(d.forkSheet?.info?.workspace?.untracked, ['notes.txt', 'scratch/output.json']);
  assert.equal(d.forkSheet?.excludedFiles, '2 untracked files will stay out: notes.txt, scratch/output.json');
});
When('I create the fork', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', title: 'Fork' });
  await this.until('fork creation progress', d => d.forkSheet?.creating === true);
});
When('I retry the fork', async function (this: ThreadbearWorld) {
  const before = (await this.app.dump()).forkSheet?.requestId;
  await this.app.do({ cmd: 'click', title: 'Retry fork' });
  assert.equal((await this.app.dump()).forkSheet?.requestId, before);
});
Then('the idle fork {string} opens', async function (this: ThreadbearWorld, title: string) {
  await this.until('the new idle fork selected', d => d.selection?.title === title && d.selection?.status === 'idle' && !d.forkSheet);
  await this.until('visible source provenance', d => d.transcript.rows.some(r => r.kind === 'note' && r.text.startsWith('Forked from [')));
  const d = await this.app.dump();
  assert.equal(d.sidebar.sections.flatMap(s => s.threads).filter(t => t.title === title).length, 1);
});
Given('the next fork copy will fail', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'forkMode', params: { mode: 'retry' } });
});
Then('the fork chooser shows the copy error', async function (this: ThreadbearWorld) {
  await this.until('the copy error', d => d.forkSheet?.error?.includes('native session could not be copied') && !d.forkSheet.creating);
  assert.equal((await this.app.dump()).selection?.title, 'Morning brief');
});
Given('the fork source is outside Git', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'forkMode', params: { mode: 'no-git' } });
});
Then('the fork chooser disables a separate worktree', async function (this: ThreadbearWorld) {
  assert.equal((await this.app.dump()).forkSheet?.info?.workspace, undefined);
  await this.app.do({ cmd: 'click', title: 'New worktree' });
  assert.equal((await this.app.dump()).forkSheet?.workspace, 'same');
});

Then('the fork remains on bruce', async function (this: ThreadbearWorld) {
  assert.match((await this.app.dump()).selection?.runner ?? '', /bruce/);
});

When('I request a fork of the busy conversation', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'type', text: '/fork', replace: true });
  await this.app.do({ cmd: 'send' });
});
Then('the chooser asks me to wait for the turn', async function (this: ThreadbearWorld) {
  await this.until('the unavailable fork explanation', d => d.forkSheet?.info?.available === false && d.forkSheet?.info?.reason?.includes('finish its turn'));
  assert.equal((await this.app.dump()).forkSheet?.canFork, false);
});

When('I click Fork again while it is creating', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', title: 'Fork' });
});
When('I cancel the fork chooser', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', title: 'Cancel' });
});
Then('the fork chooser is closed', async function (this: ThreadbearWorld) {
  await this.until('the fork chooser closed', d => !d.forkSheet);
});

When('I follow the source conversation link', async function (this: ThreadbearWorld) {
  const note = (await this.app.dump()).transcript.rows.find(r => r.kind === 'note' && r.text.startsWith('Forked from ['));
  const id = /\(thread:([^)]+)\)/.exec(note?.text ?? '')?.[1];
  assert.ok(note && id, 'source link shown');
  await this.app.do({ cmd: 'link', row: note.id, url: `thread:${id}` });
});
Then('the original conversation opens', async function (this: ThreadbearWorld) {
  await this.until('original selected', d => d.selection?.title === 'Morning brief');
});

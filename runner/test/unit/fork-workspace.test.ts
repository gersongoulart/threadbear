import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { forkWorkspaceInfo, makeForkWorkspace } from '../../src/fork-workspace.ts';

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
}

// Build commits without staging any paths. Only newly allocated worktrees
// receive Git's initial index; existing indexes are never written by tests.
function repository() {
  const home = tmpDir('tb-fork-git-');
  const bare = path.join(home, 'objects.git');
  fs.mkdirSync(bare);
  git(bare, ['init', '--bare', '--initial-branch=main']);
  const blob = git(bare, ['hash-object', '-w', '--stdin'], 'original\n');
  const tree = git(bare, ['mktree'], `100644 blob ${blob}\tfile.txt\n`);
  const commit = git(bare, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', tree], 'base\n');
  git(bare, ['update-ref', 'refs/heads/main', commit]);
  const cwd = path.join(home, 'source');
  git(bare, ['worktree', 'add', '--detach', cwd, commit]);
  return { home, cwd, commit };
}

test('a fork uses source HEAD and dirty tracked bytes, leaves untracked files out and preserves source index', async () => {
  const { cwd, commit } = repository();
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'changed\n');
  fs.writeFileSync(path.join(cwd, 'private.txt'), 'leave here\n');
  const index = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const before = fs.readFileSync(index);
  const info = await forkWorkspaceInfo(cwd);
  assert.equal(info?.head, commit);
  assert.deepEqual(info?.untracked, ['private.txt']);
  const made = await makeForkWorkspace(cwd, '12345678-0000-4000-8000-000000000000');
  try {
    assert.equal(git(made.cwd, ['rev-parse', 'HEAD']), commit);
    assert.equal(fs.readFileSync(path.join(made.cwd, 'file.txt'), 'utf8'), 'changed\n');
    assert.equal(fs.existsSync(path.join(made.cwd, 'private.txt')), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'changed\n');
    assert.deepEqual(fs.readFileSync(index), before);
    assert.equal(git(made.cwd, ['diff', '--cached']), '');
  } finally { await made.cleanup(); }
  assert.equal(fs.existsSync(made.worktree.path), false);
});

test('non-Git folders have no worktree option and creation fails without a destination', async () => {
  const cwd = tmpDir();
  assert.equal(await forkWorkspaceInfo(cwd), undefined);
  await assert.rejects(makeForkWorkspace(cwd, '12345678-0000-4000-8000-000000000000'), /Git repository/i);
});

test('a Git folder without a first commit still permits a shared-folder choice', async () => {
  const cwd = tmpDir();
  git(cwd, ['init', '--initial-branch=main']);
  assert.equal(await forkWorkspaceInfo(cwd), undefined);
});

test('a fork of a subfolder keeps that subfolder in the destination', async () => {
  const { cwd } = repository();
  // The subfolder exists at HEAD in a real repository. A directory containing
  // only untracked files must be refused rather than copied implicitly.
  fs.mkdirSync(path.join(cwd, 'untracked-dir'));
  fs.writeFileSync(path.join(cwd, 'untracked-dir', 'secret'), 'private');
  await assert.rejects(makeForkWorkspace(path.join(cwd, 'untracked-dir'), '22345678-0000-4000-8000-000000000000'), /subfolder|folder/i);
});

test('an occupied destination leaves no allocated branch and never removes the foreign folder', async () => {
  const { cwd, home } = repository();
  const id = '32345678-0000-4000-8000-000000000000';
  const occupied = path.join(home, 'source-threads', `fork-${id}`);
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'foreign'), 'keep');
  await assert.rejects(makeForkWorkspace(cwd, id), /exist|occupied/i);
  assert.equal(git(cwd, ['branch', '--list', 'thread/32345678']), '');
  assert.equal(fs.readFileSync(path.join(occupied, 'foreign'), 'utf8'), 'keep');
});

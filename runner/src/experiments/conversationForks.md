---
id: conversationForks
name: Conversation forks
title: Copy a Claude or Codex conversation into an independent thread, sharing its folder or using a separate worktree
added: 2026-11-16
on: false
reminder: 5fbf5819
---

## What it does

On an idle Claude or Codex thread, choose Fork… from its menu, or type
`/fork` in the desktop composer. Same folder copies the conversation and
shares the files. New worktree copies the conversation into a separate Git
checkout at the source revision, including tracked working-file edits.
Untracked and ignored files are left out; the chooser lists the untracked
files before creation. The fork opens ready for your next message. Its
history and attachments are independent, and its old cards cannot run
again. The original thread stays available. A busy thread, unsupported
provider or missing native session cannot be forked. Another runner's
thread forks on that runner. Phone and web show forked history but do not
yet offer creation controls.

Each completed reply has a small branch icon beside its time and cost.
“Fork from here” copies history through that reply and omits later replies.
The folder choice still describes current files; it does not rewind code.


## Lives in

`runner/src/runner/forks.ts` publishes the snapshot; `fork-workspace.ts`
creates source-based worktrees. Claude and Codex adapters copy native
sessions. `threads.forkInfo` and `threads.fork` are the protocol requests;
the relay and sync command handler send them to the owning runner. The
GPUI desktop fork chooser, reply footer icons and thread menu provide the controls. `forkedFrom`
in thread.json records provenance and request identity. Fork media and blobs
live under the child's existing thread data folder. `system.note.fork`
carries its source link through the mirror.

## Taking it out

Remove the fork chooser/menu, reply footer icons and composer interception, runner fork part,
workspace helper, adapter fork operations and related protocol/relay calls.
Remove the experiment checks and this file, then regenerate experiment and
parity documentation. Keep existing forked threads and native sessions:
they resume as ordinary threads. Their source-link notes stay readable.
Remove `forkedFrom` only after no code needs its first-message identity
correction or request deduplication.
Keep shared-worktree cleanup retention while existing forks still share a
managed checkout, even if the creation controls are removed.

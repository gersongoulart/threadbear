# Conversation forks

Status: design approved by Gerson on 16 November 2026; implemented and debug-verified. Gerson approved the exact-path integration and local release check on 20 November; release verification and landing are in progress.

## User behavior

Fork makes a new Threadbear thread with a copy of the source conversation
through its last finished turn, or through the completed reply selected with
the small inline branch icon beside its time and cost. Later replies stay
out of a message fork. The source stays intact. The new thread opens
idle, ready for a prompt; forking itself never asks a model to do work.

Each completed reply gains a “Fork from here” icon on its time-and-cost line.
The thread menu gains Fork… and the composer gains /fork. Both open the same
small chooser, using existing desktop dialog and menu components:

- Same folder: independent conversation, shared files.
- New worktree: independent conversation and separate files. Available only
  for Git repositories; shows the source revision and includes its current
  tracked changes. Untracked files are not silently copied; the chooser
  names their exclusion before creation.

The chooser shows the destination and explains the file behavior. Fork shows
progress and prevents repeat clicks until creation finishes. A failed fork
keeps the source open and shows a concrete error. It never falls back silently
from a separate worktree to shared files.

The child is titled “<source title> (fork)” and has a note linking to its
source. It inherits provider, account/pool preference, model, effort, access
mode, confinement and project membership. It gets fresh Threadbear and native
session IDs. Runtime approvals, secret requests, schedules, shares, action
buttons, review windows and done-card actions are not copied as live state.
Copied transcript history remains readable without reactivating old controls.

Fork is initially available only when the source is idle with no active
turn, pending approval or running background work. The runner enforces this
even if the client has stale state. Code rewind is outside this first version.

## Alternatives considered

1. Native session fork, recommended: preserves provider conversation state
   and keeps both sessions independently resumable.
2. New thread with a handoff summary: works across providers but loses full
   history and does not satisfy the requested Codex behavior.
3. Copy only Threadbear events: reproduces the display but not the provider's
   model context, so it is insufficient on its own.

## Runner and provider boundary

Define threads.fork in docs/protocol.md before implementation. The request
identifies the source, workspace choice and a client request ID. Repeated
requests with that ID return the same destination, including after reconnect.
The response contains the new thread summary. Persist fork provenance and the
source event boundary so the history and native session represent one snapshot.

Add a provider capability and adapter operation for native session forking.
Claude uses the installed SDK's forkSession API with the source account's
configuration. Codex uses thread/fork after verifying the installed protocol.
Unsupported providers and missing native transcripts return an explicit error;
no generated summary substitutes for a fork. Capability checks determine
whether the client offers the action.

The destination must receive its own tools, environment, Threadbear thread ID,
access policy and project instructions. Verify that inherited provider tool
definitions route to the destination, especially Codex's persisted dynamic
tools. A fork must never retain authority to act as its source thread.

Copy normalized history and required media/blob dependencies into the child,
rebasing Threadbear event envelopes and local references. Preserve historical
provider message identifiers needed for later editing. Historical costs may
remain visible, but must not be charged again to usage totals. Reopen and
resume the child after a runner restart without depending on the source's
continued existence.

Stage creation outside the visible thread list and publish only after all
required pieces succeed. Clean up only resources allocated by this request
on failure. Never alter or archive the source as part of a fork.

## Workspace behavior

Same folder explicitly bypasses automatic per-thread worktree allocation.
New worktree starts from the source's checked-out commit, not main. Apply
tracked unstaged/staged content as working-file changes in the destination
without changing the source index or staging destination changes. Conflicts,
unsupported repository states or a source changing during the snapshot fail
with an explanation. Existing setup hooks and their trust policy still apply.

Do not automatically commit the source, reset it, stash it or copy ignored
files. Respect confinement and existing permission gates throughout creation.

## Surfaces and rollout

Implement the GPUI desktop flow and runner /fork behavior for Claude and
Codex. Relay threads can fork on their owning runner through the same request;
the result opens on that runner. Phone and web read forked history and source
provenance through the existing mirror. Creation controls on phone and web
are deferred and explicitly documented in parity.ts.

Originally shipped behind an off-by-default experiment, enabled for Gerson
after implementation verification. On 25 Nov 2026, Gerson approved making
conversation forks standard and removing the experiment switch.
Keep the frozen Swift app unchanged.

## Acceptance checks

- Provider tests prove new native IDs, preserved context, original isolation,
  correct destination tool routing and independent resume after restart.
- Runner tests cover settings, provenance, event/media copying, inert copied
  controls, idempotency, stale busy state and rollback after partial failure.
- Git fixture tests prove source revision and tracked dirty content survive a
  worktree fork, and source index bytes never change. Shared-folder forks do
  not allocate a worktree. Failed worktree forks never share files silently.
- Scenario tests prove another Mac, phone and web see the same copied history
  and provenance. Add the protocol parity row and generated documentation.
- Gherkin and scripted GPUI checks cover the chooser, disabled unsupported
  states, progress, failure and opening the destination. Inspect a dark-mode
  screenshot of the running debug app.
- Run focused tests first, then the repository checks available on Gerson's
  hosts. Do not contact Mike's hosts. Demonstrate native context continuity in
  a temporary dev runner with tiny prompts, using the cheapest suitable models.

## Delivery constraint

Gerson prohibits all staging and unstaging without explicit authorization.
Implementation and validation may proceed after design approval, but committing
and tb land must wait for separate authorization to stage the exact paths.
No Git index has been intentionally modified while preparing this draft.

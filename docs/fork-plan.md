# Conversation fork implementation plan

Approved design: docs/fork-design.md. Execute in this worktree without staging,
unstaging, commits, landing or changing the source Git index.

## 1. Native provider copy

Files: runner/src/adapters/types.ts, adapters/claude/adapter.ts,
adapters/codex/adapter.ts, adapters/codex/types.ts, adapters/codex/surface.ts,
provider adapter unit tests.

- [x] Define ForkSessionRequest (threadId, account, cwd, destinationCwd,
  sessionId, destinationThreadId, title), ForkSessionResult (sessionId), and
  optional AgentAdapter.forkSession.
- [x] Test native fork invocation, account isolation, errors and fresh IDs.
- [x] Implement Claude SDK session copy and Codex thread/fork. Rebind the
  destination's tools/config when resumed, with a test that tools cannot
  target the source. Run the focused provider tests.

## 2. Snapshot runner and workspace

Files: runner/src/runner/forks.ts, runner/src/fork-workspace.ts,
runner/src/runner.ts, runner/src/store.ts, runner/src/rpc.ts,
runner/src/parity.ts, runner/test/unit/forks.test.ts,
runner/test/unit/fork-workspace.test.ts, docs/protocol.md.

- [x] Document threads.forkInfo and threads.fork protocol before code changes.
- [x] Test idle validation, copied history, inert controls, settings,
  provenance, idempotency, restart, failure rollback and source isolation.
- [x] Test a Git fixture: fork the source HEAD and tracked dirty bytes,
  omit untracked/ignored files, preserve source index bytes and refuse races.
- [x] Implement atomic publishing, independent media/blobs and native IDs.
- [x] Run focused runner/workspace tests and typecheck.

## 3. User entry points and relay

Files: desktop/gpui/src/sidebar.rs and fork dialog module,
runner/src/slash-commands.ts, runner/src/relay.ts, runner/src/sync.ts,
features/fork.feature and test support.

- [x] Add /fork handling and chooser request using the existing client event
  pattern. Both entry points show same-folder versus separate-worktree choice.
- [x] Route fork requests to the source runner, wait for its real result and
  open the returned thread; show busy/error states and tooltips.
- [x] Add Gherkin/scenario cases and parity declaration. Phone/web view forks
  through the existing normalized event mirror; no new creation control.

## 4. Rollout and verification

Files: runner/src/experiments/conversationForks.md, docs/guide.md,
docs/experiments.md, docs/parity.md, docs/on-your-mac.md, docs/forking.md.

- [x] Add off-by-default experiment with check-in schedule and docs.
- [x] Run focused tests, generated-doc checks and inspect scripted dark-mode GPUI output.
- [x] Run the full repository check after a Gerson host is supplied or local whole-suite execution is explicitly approved. Gerson approved the local exception on 20 November; the full check passed.
- [x] Exercise tiny real Claude and Codex forks in a temporary dev runner,
  stop owned processes, and record any unavailable account or build host.
- [x] Review implementation against design and inspect source index checksum.
- [x] Present unstaged, verified changes; request exact-path staging only
  after implementation is reviewable. Do not claim shipped before landing.

- [ ] Stage the exact reviewed paths, commit and land after explicit approval. No push is included.
# Message footer extension, approved 18 November 2026

The small branch icon follows each completed reply's time and cost on the
same line. Its tooltip is “Fork from here”. It opens the existing chooser
and copies history through that reply, excluding later turns. Workspace
choices still describe current files; this does not rewind code.

- [x] Add runner/provider regressions for an earlier completed turn, invalid
  boundaries and retry identity, and observe failure before implementation.
- [x] Pass optional `throughTurnId` through preview, creation and relay; validate
  it against a visible completed turn and use that boundary for both native
  provider history and normalized events. Old requests keep latest behavior.
- [x] Add native Claude UUID and Codex lastTurnId cutoffs. Reject missing
  native boundaries rather than silently copying newer context.
- [x] Add footer icons and carry their sequence through the existing chooser.
- [x] Verify focused tests, typecheck, desktop build, and actual demo clicks
  with an earlier reply followed by a later reply. Capture the built footer.
- [x] Keep all changes unstaged pending explicit Git-index authorization.

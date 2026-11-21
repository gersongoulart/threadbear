# Gates: conversation forks

OWNS: runner/**, desktop/**, features/**, docs/**, GATES.md

Scope: Native Claude and Codex forks, shared-folder or separate-worktree choice,
desktop and relay flow, copied history, restart recovery and safe rollout.

- [x] G1: Native provider forks preserve context and independent identity.
  CHECK: node --test --test-reporter=tap test/unit/provider-forks.test.ts
  EXPECT: # fail 0
  CWD: runner
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gerson/threadbear-threads/slot-1/runner; path=5f6393739807/45 entries; EXPECT=matched; output-sha256=5305d729ba28c8505acb2e18c1d37f45c572766bc25c74c8b20d9ea6010cbb9f; output-bytes=1719
- [x] G2: Runner snapshots publish independent resumable threads and inert history.
  CHECK: node --test --test-reporter=tap test/unit/forks.test.ts test/unit/worktrees-cleanup.test.ts
  EXPECT: # fail 0
  CWD: runner
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gerson/threadbear-threads/slot-1/runner; path=5f6393739807/45 entries; EXPECT=matched; output-sha256=85a1112b321c0383b105534270e94a1fb7e86899c7870bf3846d5082807c33b4; output-bytes=9983
- [x] G3: Separate-worktree forks preserve source revision, files and source index.
  CHECK: node --test --test-reporter=tap test/unit/fork-workspace.test.ts
  EXPECT: # fail 0
  CWD: runner
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gerson/threadbear-threads/slot-1/runner; path=5f6393739807/45 entries; EXPECT=matched; output-sha256=ed8dbfa2ee28f20cbb3e8f0a36dd6a72df32b54bf6e8824fd4ef29f5e7a3bbfc; output-bytes=1417
- [x] G4: Desktop chooser, progress, errors and relay results work visibly.
  EVIDENCE: eight real GPUI scenarios, 90 steps passed; local automation debug build passed; chooser and child screenshots inspected by root, including visible clickable source provenance and the inline branch icon beside time/cost
- [x] G5: Protocol, mirrored scenarios, experiment and guide match behavior.
  CHECK: node --test --test-reporter=tap test/unit/scenarios.test.ts test/unit/parity.test.ts test/unit/experiments.test.ts test/unit/experiment-docs.test.ts test/unit/relay-buttons-backend.test.ts test/unit/context-budget.test.ts
  EXPECT: # fail 0
  CWD: runner
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gerson/threadbear-threads/slot-1/runner; path=5f6393739807/45 entries; EXPECT=matched; output-sha256=ce9c32cb91e6330176d84ae52b010bdccc0571526a6015dc5c5f073ff9d407d6; output-bytes=7045
- [x] G6: Changes pass available repository checks and stay unstaged.
  CHECK: npm run typecheck
  EXPECT: tsc --noEmit -p .
  CWD: runner
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gerson/threadbear-threads/slot-1/runner; path=5f6393739807/45 entries; EXPECT=matched; output-sha256=c0624f55b08d998e38707f6629ae0a7170a79eddba1589b5b3a0acb069e82d67; output-bytes=58
- [ ] G7: Full repository check passes and the feature lands for the installed app.
  EVIDENCE: Gerson approved the exact 68-path staging manifest, local whole-suite exception and integration on 20 Nov. Full `scripts/one-build.sh ./check.sh --local` exited 0: runner suite 3677 passed, 4 skipped, 0 failed; desktop core/client tests and workspace all-target check passed, as did typechecks, web tests, site build and feature pairing. Eight fresh desktop scenarios/90 steps passed. Landing and installed-app verification remain pending. Private logs: `.fixtures/fork/release-check.log` and `release-ui-check.log`.

- [x] G8: Inline message forks include the selected reply and omit later context.
  EVIDENCE: 18 Nov 2026: 118 focused runner/provider/relay/scenario/parity/experiment/context checks passed; runner and Convex typechecks passed; 8 GPUI scenarios/90 steps passed on rebuilt automation binary. Reviewed synthesized end_turn boundaries and historical cost baselines, fixed both findings with regressions. Real SDK mutation retained tool/result and omitted later input. Captured and inspected `.fixtures/fork/inline-footer.png`; manual demo fork has first reply=true, later reply=false. Git index SHA-256 unchanged.

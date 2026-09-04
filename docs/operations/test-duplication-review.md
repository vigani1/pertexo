# Test duplication review

This ledger records the disposition of every clone reported by the exact A-11
baseline command at commit `8ec602a` (tree `b667367`). The scan analyzed 351
files/94,939 lines and reported 25 clone occurrences, 1,977 aggregate duplicated
lines, and 16,403 duplicated tokens (2.08%). Occurrence lines below sum to 2,002
because overlapping clone regions are counted once in the aggregate statistic.

```sh
pnpm dlx jscpd@4.0.5 apps/*/test packages/*/test \
  --min-lines 18 --min-tokens 130 --format typescript \
  --reporters console --ignore '**/dist/**'
```

“Shared setup” means the repeated ownership was extracted. “Scenario-local” is
intentional repetition whose visible actions or assertions improve review.
“False positive” means textual similarity crossed distinct owners and was not
centralized merely to satisfy the detector.

| Reports | Lines | Pair | Classification and disposition |
| --- | ---: | --- | --- |
| 1 | 30 | workflow-engine foreach (same file) | Scenario-local; retained as two explicit conflict scenarios (currently 29 lines). |
| 2 | 40 | workflow-engine advance transitions ↔ checkpoint seam | Shared setup; moved runtime/checkpoint construction to `packages/workflow-engine/test/support/advance-workflow.fixture.ts`. |
| 3 | 34 | workflow-engine advance branching ↔ transitions | Shared setup; moved runtime/checkpoint construction to `packages/workflow-engine/test/support/advance-workflow.fixture.ts`. |
| 4 | 115 | database transport part 2 ↔ part 1 | Shared setup; moved PostgreSQL lifecycle to `packages/database/test/support/transport.integration.support.ts`. |
| 5–7 | 39/224/23 | database schedule triggers part 2 ↔ part 1 | Shared setup; moved database creation, migration, clocks, and cleanup to `packages/database/test/support/schedule-triggers.integration.support.ts`. |
| 8 | 26 | OIDC browser-binding migration ↔ preview-deadline migration | Shared setup; moved disposable migration-database ownership to `packages/database/test/support/disposable-database.ts`. |
| 9–11 | 59/135/224 | database control-ledger coordinator part 2 ↔ part 1 | Shared setup; moved database/service lifecycle and ledger construction to `packages/database/test/support/control-ledger-coordinator.integration.support.ts`. |
| 12 | 274 | artifact control ledger part 2 ↔ part 1 | Shared setup; moved ledger environment and fixture construction to `packages/artifact-store/test/support/control-ledger.fixture.ts`. |
| 13 | 33 | worker bootstrap (same file) | Scenario-local; retained explicit node-attempt and preview-maintenance owner cases (currently 32 lines). |
| 14–15 | 246/61 | worker transport part 2 ↔ part 1 | Shared environment only; PostgreSQL/Redis/BullMQ lifecycle remains in `apps/worker/test/support/transport.integration.support.ts`, while inbox transaction writes and bounded dispatcher actions were restored to each scenario file. Their current 109-line overlap is intentionally scenario-local. |
| 16 | 44 | worker node-attempt handler ↔ runtime | False positive across handler and runtime contracts. Handler construction later moved to its owner-local fixture; runtime construction remains visible locally. |
| 17 | 139 | worker node-attempt handler part 2 ↔ part 1 | Shared setup; moved handler dependencies and domain construction to `apps/worker/test/support/node-attempt-handler.fixture.ts`. |
| 18 | 31 | worker node-attempt handler part 2 (same file) | Scenario-local; retained explicit provider-failure outcomes (currently 30 lines). |
| 19 | 24 | worker coordinator engine ↔ node-attempt engine | Shared setup; moved the executable graph to `apps/worker/test/support/execution-engine.fixture.ts`. |
| 20 | 22 | coordinator consumer fixtures ↔ HTTP node-attempt fixture | Shared setup; moved tenant-scoped worker queries to `apps/worker/test/support/workspace-query.ts`. |
| 21 | 28 | coordinator consumer fixtures ↔ HTTP node-attempt fixture | Shared setup; moved release activation to `apps/worker/test/support/compatibility-release.fixture.ts`. |
| 22 | 37 | lifecycle-command run ↔ retention run | False positive across separately deployable app contracts; retained (currently 36 lines). |
| 23 | 33 | API real identity graph ↔ workflow-run persistence graph | False positive across raw authoring and executable-compilation public seams; retained (currently 32 lines). |
| 24–25 | 49/32 | API bootstrap ↔ connection HTTP stack | Shared setup; moved API configuration, readiness, and workflow-runtime construction to `apps/api/test/support/api-platform.fixture.ts`. |

The current exact scan reports 6 occurrences/267 aggregate duplicated lines
(0.29%) across 362 files/93,514 lines. Their pair identities, fragment hashes,
individual line ceilings, classifications, and narrow reasons are enforced by
`infrastructure/test-duplication-baseline.json` through
`pnpm duplication:check`. The source-side baseline is reviewed in the same
manifest. New fragments, missing reviewed fragments, semantic hash changes, or
aggregate/per-fragment growth fail protected CI.

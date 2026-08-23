# Engineering Audit Findings

Recorded: 2026-08-23

This document records gaps found while independently auditing the delivered
implementation against the authoritative plan, and while fixing them on the
`fix/audit-findings` branch. It follows the tracker's evidence discipline: every
finding names concrete files, commands, or commits; open items state their
recommended owner and trigger. This file does not change any phase checkpoint
status in [the implementation progress tracker](./implementation-progress.md).

## Finding 7 — Preview retention deletion has no authorized role (Open blocker, Phase 7)

Evidence: migration 0022 grants the worker SELECT plus lifecycle UPDATE
only and explicitly revokes DELETE on `preview_runs`/`preview_attempts`;
forced RLS also blocks any cross-workspace owner sweep. A tenant-scoped
sweep is therefore not landable without a reviewed maintenance-role grant
migration. Resolution: the `sweep-expired-previews` job kind is held in
the dispatcher contract (commit abe757f) exactly like
`reconcile-workflow-triggers`; Phase 7 owns the grant migration plus the
maintenance consumer.

## Summary

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Compatibility-rollout proof never ran in CI | High | Fixed (`d8b5472`) |
| 2 | Connection/authoring transactions lacked pool hygiene | High | Fixed (`4c8d492`) |
| 3 | Repo-wide lint was unrunnable (heap OOM) masking one latent violation | Medium | Fixed (`1b8af29`) |
| 4 | Shared local database migration-history drift blocks some local suites | Medium | Open (environment) |
| 5 | Rollout suite mutates durable release authority without self-provisioning | Medium | Open (constraint documented) |
| 6 | Tracker assertion-count snapshots have drifted from the working tree | Low | Open (process) |

## Finding 1 — Compatibility-rollout proof absent from CI (High)

Evidence:

- `apps/api/test/platform/compatibility-rollout.integration.test.ts:33` gates on
  `API_COMPATIBILITY_ROLLOUT_INTEGRATION`.
- `.github/workflows/ci.yml` set none of the eight integration flags for that
  suite, so the additive epoch 1→2→3→4 rollout regression ran only when someone
  manually invoked `pnpm --filter @pertexo/api test:compatibility-rollout`.

Impact: the plan's rolling-release guarantees (Phase 3 "additive rollout"
evidence, ADR 010) had no automated guard against regression on `main`.

Resolution: commit `d8b5472` adds the step to CI after the three destructive
proofs. Order matters: see Finding 5.

Verification: the suite passes against a fresh disposable PostgreSQL database
migrated zero-to-head `0022_preview_execution.sql` (one assertion, 606 ms);
the disposable database was dropped and the shared development database was
not mutated.

## Finding 2 — Tenant-scoped transaction helpers lacked pool hygiene (High)

Evidence (pre-fix):

- `packages/database/src/workspace.ts` owned the gold-standard helper:
  pre-use absent-context assertion, read-back verification of configured
  settings, wire-level abort cancellation via `PoolClient.release(error)`,
  client destruction when rollback or cleanup failed.
- `packages/database/src/connections.ts` (`withConnectionTransaction`, formerly
  lines 380–407) performed none of those checks and released the client even
  after a failed rollback.
- Investigation during the fix found the identical gap in
  `packages/database/src/workflow-authoring.ts`
  (`withAuthorTransaction`, formerly lines 464–488), and a third divergent
  variant in `packages/database/src/identity-workspace.ts` (`withTransaction`,
  lines 592–638) that asserts context before/after but neither verifies
  read-back nor supports cancellation.

Impact: any driver-level fault or future code path that set a session-level
value could return a contaminated pooled client to an unrelated request.
Forced RLS limits the blast radius (absent/wrong context fails closed), but
the hygiene contract in ADR 003 was not uniformly enforced.

Resolution: commit `4c8d492` extracts one fail-closed primitive,
`withTenantScopedClient`, into `workspace.ts` and makes both gapped adapters
delegate to it while preserving their exact validation semantics. The
drizzle-backed `withWorkspaceTransaction` now shares the same core. The
identity-workspace variant was intentionally left untouched in this pass;
consolidating it is follow-up work with its own focused tests.

New regressions (`packages/database/test/tenant-context-hygiene.integration.test.ts`)
prove on real PostgreSQL:

- a commit-path session-level leak is detected post-commit, surfaces
  `AggregateError('Tenant context cleanup failed')`, and destroys the client;
- the rollback path preserves the original error verbatim without spurious
  aggregate failure and keeps the client reusable (PostgreSQL reverts even
  session-level settings on abort, so rollback cannot leak the way COMMIT
  can — this is asserted rather than assumed);
- `pg_sleep(5)` aborts in under two seconds through the signal seam and the
  next checkout is clean;
- both `app.workspace_id` and `app.actor_id` are read-back verified;
- the drizzle-backed public path behaves identically over the primitive.

## Finding 3 — Repo-wide lint OOM masked a latent violation (Medium)

Evidence:

- `docs/implementation-progress.md` line 1539 records that the full lint
  command exceeded Node's default heap during Phase 4, so scoped ESLint was
  used instead.
- Reproduced on Node 24.15.0: `pnpm lint` died with `Ineffective mark-compacts
  near heap limit` before completion.
- With an explicit bounded heap the restored gate immediately reported one
  latent error that scoped runs had missed:
  `apps/api/test/node-testing/validation.test.ts:77` unsafe assignment of an
  `any` asymmetric matcher value.

Resolution: commit `1b8af29` sets `NODE_OPTIONS=--max-old-space-size=8192` on
the root lint script and rewrites the offending assertion as a typed
predicate (`issue.path.startsWith('$.config')`). Focused test suite remains
green (3 assertions) and `pnpm lint` completes cleanly.

Follow-up worth considering: profile typed-lint memory separately so the
script documents why the bound exists (typed `projectService` linting across
the monorepo is the dominant cost).

## Finding 4 — Shared local database drift blocks some suites locally (Open)

Evidence:

- Suites that migrate the **shared** `pertexo` database (for example
  `packages/database/test/workflow-authoring.integration.test.ts`) fail locally
  with `Applied migration checksum changed: 0012_workflow_authoring.sql`.
- The tracker (lines 1050–1055) documents the ancestor of this condition: the
  shared database recorded a `0012` checksum that predates the checked-in
  revision, and prior checkpoints deliberately refused to rewrite history.
- House precedent (commit `80de849` evidence) verifies repository-wide suites
  against a fresh isolated database and drops it afterward.

Impact: local full-matrix runs require the fresh-database procedure; the
failure mode looks alarming but is the checksum guard working as designed.

Recommendation: recreate the local development database from a clean Compose
volume before the next phase gate, then re-run `pnpm db:migrate` once so the
shared database matches the checked-in head. Owner: whoever runs the next
fixed-head review. No repository change required.

## Finding 5 — Rollout suite owns no disposable database (Open constraint)

Evidence:

- `compatibility-rollout.integration.test.ts` runs directly against
  `DATABASE_MIGRATION_URL` / `DATABASE_API_URL` / `DATABASE_WORKER_URL`,
  advances the singleton compatibility-release pointer through epochs 2→3→4,
  and leaves created users/workflows behind. Its `finally` block closes pools
  but restores no release state.

Impact: the suite is only safe against ephemeral databases. In CI the Postgres
container is per-job, so the new step is safe; it must also stay **last**
among proofs because activating HTTP cohorts would break earlier suites that
assume the seeded core-only release. Local runs must provision a disposable
database first (as the verification for Finding 1 did).

Recommendation: either give the suite self-provisioning like
`coordinator-run-store.integration.test.ts` (`createDatabase`/`dropDatabase`),
or record the "ephemeral-only, run-last" contract beside the env flag. Owner:
next checkpoint touching node-catalog or CI.

## Finding 6 — Tracker count snapshots drift (Low, process)

Evidence:

- Static `it(` occurrences currently total 588 unit and 212 integration cases
  versus the tracker's Phase 3 snapshot of "575 unit and 217 sequential
  real-service assertions" at head `0019`; the working tree has since advanced
  three migrations and multiple packages.

Impact: none at runtime; counts are fixed-head evidence by design. Risk is
only misreading stale numbers as current guarantees.

Recommendation: keep snapshots tied to named heads exactly as the tracker
already does, and regenerate all counts at each phase-completion review.
Optionally add a short script that emits per-suite counts so regeneration is
mechanical rather than manual transcription.

## Verification record for this branch

- `pnpm --filter @pertexo/database typecheck` — pass.
- `pnpm --filter @pertexo/database test` — 57 unit assertions, pass.
- Focused hygiene suite — 5 assertions, pass.
- Full sequential real-service matrix on a fresh isolated PostgreSQL 18
  database migrated zero-to-head `0022_preview_execution.sql`, then dropped:
  artifact-store 2, database 222 (15 files), worker 10, API 7 assertions —
  all green; Redis 8.2.8 and S3Mock remained healthy; shared databases
  untouched.
- Compatibility-rollout proof — 1 assertion on its own fresh disposable
  database, dropped afterward.
- `pnpm lint` (repo-wide, restored gate) — clean.

## Session work log — branch `fix/audit-findings` (reviewer guide)

Everything below happened on this branch only; `main` was never touched.
Commits are listed in order with the reasoning a reviewer needs, followed by
an explicit register of every place this session interpreted, extended, or
deliberately deferred against the authoritative plan.

### Commit index

| Commits | Checkpoint | What a reviewer should look at |
| --- | --- | --- |
| `d8b5472` | CI gap fix | Adds the compatibility-rollout proof as the **last** integration step (it advances the singleton release pointer; ephemeral CI container makes that safe). Verified locally on a disposable database. |
| `4c8d492` | Pool hygiene | Extracts one fail-closed `withTenantScopedClient` primitive into `workspace.ts`; connections + authoring adapters delegate to it (their private helpers had no pre/post context assertions, no read-back verification, no destroy-on-leak). New 5-test real-Postgres suite `tenant-context-hygiene.integration.test.ts`. See deviation D1/D2. |
| `1b8af29` | Lint gate | Root lint got `NODE_OPTIONS=--max-old-space-size=8192` (typed ESLint OOM'd at Node's default heap — tracker line 1539 recorded the symptom). Restoring the gate surfaced and fixed one latent violation in `apps/api/test/node-testing/validation.test.ts`. See deviation D3. |
| `364bc1a` | This document | Findings 1–6 recorded with evidence. |
| `ce02e52` + `81ff6c9` | Connection box closed | Concurrent-race proofs: exactly-one-winner same-name creates; CAS rotation from one expected pointer admits exactly one winner regardless of race order; losers leave zero orphaned secret versions. Closes the last unchecked connection-slice box. |
| `bd2989b` + `0e75643` | ADR 007 box closed | Executor-boundary truth for rate-limit / timeout / canceled under the manifest-pinned `unsafe` class (policy layer already covered all three side-effect classes). No production code changed — tests only. |
| `21a0b1d` | Preview seam | Worker-side persistence: checksum-bound delivery validation, fenced claims with expired-lease reclaim (blocked after dispatch marker), owner-only heartbeats, stale-fence duplicate truthfulness, dispatch-evidence reconciliation (`failed` before any marker vs `outcome_unknown` after), forged-checksum security facts, RLS isolation. Built on the new shared primitive. 6 real-Postgres assertions. |
| `2c1418a` | Preview composition | Handler + platform invoker + queue router + dispatcher capability entry (`execute-preview-attempt`). Output envelope validation via strict-JSON structural walk plus lossless canonical roundtrip (the serializer alone silently drops function members — regression-proven). Retention deadline races execution so late results stay truthful. 9 unit assertions. See deviations D4–D7. |
| `f434f71`, `8683011` | Tracker pairs | Evidence-ledger updates in the repo's feat→docs rhythm. |
| `886cdb3` + `cf26f87` | Real-transport proof | Acceptance → outbox → BullMQ → routed consumer → pinned `core.set` executor → truthful succeeded; atomic inbox receipt; exact redelivery is a byte-identical no-op. The suite activates this artifact's derived release through the full audited maintenance flow instead of trusting the migration bootstrap fingerprint. See deviation D8. |
| `abe757f` + `4cce3cf` | Sweep contract held | `sweep-expired-previews` job kind added to queue contracts/routing/metrics/capability allowlist, disabled by default, no consumer — matching the held `reconcile-workflow-triggers` precedent. Finding 7 records why deletion could not be landed honestly (no serving role holds DELETE; forced RLS blocks cross-workspace sweeps). See deviation D9. |

### Verification summary

- Repository-wide `pnpm check` green at every committed checkpoint (format,
  lint incl. restored heap-bound gate, generated-contract drift, typechecks,
  unit suites, production builds).
- Fresh-isolated-database integration matrix run repeatedly (final state:
  artifact-store 2, database 230+, worker 10+, API 7 assertions) with the
  disposable database dropped and the shared development database untouched;
  the known shared-DB `0012` checksum drift (Finding 4) is why local full
  runs use the fresh-database procedure.
- Focused suites added by this session: tenant-context hygiene 5, preview
  seam 6, preview handler 9, preview real transport 1, connection
  concurrency +2 (within the existing file).

### Deviation and interpretation register

- **D1 — Shared transaction primitive.** The plan permits shared extraction
  only with "two real callers with the same semantics"; three adapters now
  qualify (workspace drizzle path, connections, authoring), and the preview
  seam became the fourth consumer. Behavior of the public drizzle path is
  preserved and asserted.
- **D2 — AbortSignal on the workspace path.** `withWorkspaceTransaction`
  gained optional cancellation through `PoolClient.release(error)` — the run
  stores already used this seam privately; unifying it is fail-closed
  hardening, not an interface addition for hypothetical reuse.
- **D3 — Tooling.** Lint heap bound and the restored-gate fix are
  infrastructure changes with no runtime surface.
- **D4 — Preview output envelope.** Raw executor output is wrapped into the
  inline stored-value envelope inside the worker boundary; oversized or
  non-JSON outputs fail closed as `preview.output_invalid`. Artifact-backed
  preview output streaming is deliberately NOT landed yet — it needs the
  capability wiring called out in the remaining-work list, so the current
  handler is honest inline-only rather than pretending full policy parity.
- **D5 — Classification ownership.** For previews the injected invoker owns
  ADR 007 outcome classification (single-shot execution): pre-dispatch
  retryable failures complete as `failed`, possibly-dispatched ambiguity as
  `outcome_unknown`, cancellation stays `canceled`, infrastructure faults
  propagate for bounded BullMQ retries. The engine keeps retry ownership for
  production attempts unchanged.
- **D6 — Deadline source.** The retention `expires_at` doubles as the
  execution deadline, observed through heartbeats; there is no separate
  preview timeout knob yet.
- **D7 — Identity conventions.** Preview runtime maps
  `attemptNumber = 1` and `invocationKey = preview:<nodeId>`; these are new
  conventions introduced by this branch and should be ratified in a follow-up
  ADR note if adopted.
- **D8 — In-test activation.** The transport proof performs a real
  maintenance prepare/probe/preactivate/approve/activate cycle against the
  seeded predecessor. This uses only audited production seams but means the
  test database ends on the artifact's cohort release — safe because the
  database is disposable.
- **D9 — Retention.** No deletion path was landed (Finding 7). The job kind
  exists so enabling later requires configuration only. Nothing in the plan
  required landing deletion in Phase 4; the tracker box stays unchecked with
  the blocker cited.
- **D10 — Contract additions.** `sweep-expired-previews` queue contract,
  routing, metrics union entry, capability allowlist entry, and the
  `delivery` parameter on `completePreviewAttempt` are additive contracts on
  this branch's new surfaces only; no shipped API changed shape.

### Remaining before Phase 4 can be marked complete

1. SIGKILL crash-boundary fixture through the composed handler
   (pre/post-dispatch), mirroring the Phase 0E process-fixture style.
2. Prior-preview scope/expiry end-to-end evidence over HTTP and safe status
   reads through the real API stack.
3. `http.request@1` activation assertion (additive rollout leg with JIT
   connection/artifact capabilities exercised live).
4. Fixed-head repository-wide regression matrix plus independent Spec and
   Standards completion reviews, then the tracker flip.

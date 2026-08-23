# Engineering Audit Findings

Recorded: 2026-08-23

This document records gaps found while independently auditing the delivered
implementation against the authoritative plan, and while fixing them on the
`fix/audit-findings` branch. It follows the tracker's evidence discipline: every
finding names concrete files, commands, or commits; open items state their
recommended owner and trigger. This file does not change any phase checkpoint
status in [the implementation progress tracker](./implementation-progress.md).

## Summary

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Compatibility-rollout proof never ran in CI | High | Fixed (`d8b5472`) |
| 2 | Connection/authoring transactions lacked pool hygiene | High | Fixed (`4c8d492`) |
| 3 | Repo-wide lint was unrunnable (heap OOM) masking one latent violation | Medium | Fixed (`1b8af29`) |
| 4 | Shared local database migration-history drift blocks some local suites | Medium | Open (environment) |
| 5 | Rollout suite mutates durable release authority without self-provisioning | Medium | Open (constraint documented) |
| 6 | Tracker assertion-count snapshots have drifted from the working tree | Low | Open (process) |
| 7 | Preview sweep was advertised without a consumer or authorized deletion role | High | Fixed (`dd0d665`) |
| 8 | Preview worker bypassed the production mapping resolver | Critical | Fixed (`dd0d665`) |
| 9 | API and worker pinned different compatibility fingerprints | Critical | Fixed (`dd0d665`) |
| 10 | Unsafe post-dispatch deadlines could be reported as definite timeout | Critical | Fixed (`dd0d665`) |
| 11 | Production preview composition omitted readiness/capabilities and leaked on startup failure | High | Fixed (`dd0d665`) |
| 12 | Lease loss could manufacture cancellation; reconciliation ignored side-effect class | Critical | Fixed (`dd0d665`, `5dfb5f0`) |
| 13 | Artifact output, terminal audit/usage/metrics, process crash proofs, and retention deletion are incomplete | High | Open (activation blockers) |
| 14 | Cancellation during preview input mapping could be mislabeled as executor failure | High | Fixed (`d44ce6b`) |

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

## Finding 7 — Unsupported preview-sweep capability was advertised (Fixed)

Evidence: migration 0022 grants the worker SELECT plus lifecycle UPDATE
only and explicitly revokes DELETE on `preview_runs`/`preview_attempts`;
forced RLS also blocks any cross-workspace owner sweep. A tenant-scoped
sweep is therefore not landable without a reviewed maintenance-role grant
migration. Commit `abe757f` nevertheless advertised `sweep-expired-previews`
through queue contracts, routing, configuration, and metrics without any
consumer. That made readiness/configuration describe a capability the worker
could not perform. Commit `dd0d665` removes the unsupported contract. Preview
retention deletion remains an open Phase 4 lifecycle requirement whose role,
bounded cursor, artifact ordering, and consumer must be designed before it is
advertised.

## Findings 8–12 — Preview execution correctness review (Fixed)

The fixed-head Spec and Standards review found that the initial preview worker
checkpoint passed its local tests but did not satisfy the cross-package
production contract:

- `2c1418a` invoked the persisted executor with the raw preview input instead
  of the graph node's `ValueSource` mappings. `dd0d665` extracts and reuses the
  production mapping path, rejects isolated `node_output` sources, validates
  the persisted executable snapshot, and changes the real-transport fixture to
  prove a `run_input` mapping.
- API acceptance persisted the browser-safe node-catalog fingerprint while the
  worker resolves engine-composed compatibility releases. `dd0d665` makes API
  acceptance persist that same composed epoch/fingerprint and regression-tests
  the exact identity.
- A retention/deadline observation after an unsafe dispatch could complete as
  `timed_out`. `dd0d665` races the durable deadline, completes pre-dispatch
  expiry without invoking, and records `outcome_unknown` after an unsafe
  dispatch. It also rejects a duplicate dispatch marker.
- The default NestJS composition created no preview-only shared consumer,
  advertised no preview readiness, omitted production connection/artifact
  factories, and could leak the preview store if consumer construction threw.
  `dd0d665` corrects the provider/capability composition and lifecycle cleanup
  with focused bootstrap and construction-failure regressions.
- A heartbeat failure aborted execution but could let an abort-classifying
  invoker persist `canceled`. `dd0d665` races lease-authority failure as an
  infrastructure error and commits no terminal claim. The original
  reconciler also marked every dispatched class unknown and undispatched work
  failed. `5dfb5f0` permits expired redelivery to reclaim undispatched, `safe`,
  and `idempotent_with_key` work while preserving the stable provider key;
  only expired unsafe dispatched work reconciles to `outcome_unknown`.

Verification at those checkpoints includes affected format/ESLint gates,
database/queue/observability/workflow-engine/worker/API typechecks and unit
suites, plus the six-scenario real-PostgreSQL preview-worker integration file.
The corrected-head repository-wide and complete real-service gates are
recorded below rather than inferred from these focused checks.

## Finding 13 — Preview activation remains incomplete (Open)

The corrected foundations are intentionally still gated. ADR 016 and the Phase
4 checklist require production bounded artifact output, terminal audit and
usage facts, preview metrics, retention deletion (including owned artifacts),
process crash-boundary proofs, prior-preview/status HTTP evidence, and the HTTP
activation rollout. Commit `b850f53` closes the automatic durable
reconciliation-delivery gap but none of these remaining requirements.
Production node-test route activation and the Phase 4 registry release must
remain disabled until those requirements and the final independent fixed-head
reviews pass.

## Finding 14 — Mapping cancellation lost its canonical outcome (Fixed)

The Standards review at `cd8a62b` found that the production mapping resolver
raises `WorkflowEngineError('attempt_aborted')` when cancellation wins before
provider execution, but the preview invoker handled only mapping validation
errors explicitly. The generic executor classifier could therefore label a
pre-dispatch cancellation as `preview.executor_failed`.

Commit `d44ce6b` maps that engine decision to the canonical canceled preview
outcome. Its regression starts with an aborted signal, enters a real
`run_input` mapping, and proves the executor is never called. The same commit
makes the durable preview store required in the composition type, removing a
redundant runtime guard for an impossible optional state. All 98 worker tests
and repository-wide `pnpm check` pass. Independent Standards and Spec
re-reviews against exact head `d44ce6bcf5a705cfa89d8dae1fbf97724c099edb`
report no remaining blocker/high merge finding.

## Verification record for this branch

The original audit recorded the following checks through `ee76bad`; they are
historical evidence and do not substitute for the final corrected-head gate:

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

Corrections `dd0d665` and `5dfb5f0` pass affected formatting/ESLint,
typechecks, builds, unit suites, and the focused six-scenario real-PostgreSQL
preview-worker integration test. At corrected documentation head `d3f1397`:

- root `pnpm check` passes formatting, repository-wide ESLint, generated
  contract drift, every workspace typecheck and unit suite, and every
  production build;
- the dependency-ordered real-service matrix passes on disposable PostgreSQL
  18 at migration head `0022_preview_execution.sql`: artifact-store 2 in
  0.269 s, database 230 across 16 files in 16.86 s, worker 11 across four files
  in 4.48 s, and API 7 across two active files in 6.37 s;
- the compatibility-rollout suite passes its one assertion last in 1.35 s;
  and
- the disposable database was dropped afterward; PostgreSQL 18, Redis 8.2.8,
  and S3Mock 5.1.0 remained healthy.

At fixed implementation head `d44ce6b`, root `pnpm check` passes again after
the mapping-cancellation repair, including all 98 worker assertions. The Spec
and Standards fixed-head re-reviews report zero blocker/high merge findings.
At that head, the open Phase 4 activation gates in Finding 13 remained
unchanged; the later `b850f53` checkpoint closes only automatic reconciliation
delivery.

## Session work log — branch `fix/audit-findings` (reviewer guide)

Everything below was developed and reviewed on this branch before any
fast-forward merge to `main`. Commits are listed in order with the reasoning a
reviewer needs, followed by an explicit register of every place this session
interpreted, extended, or deliberately deferred against the authoritative
plan.

### Commit index

| Commits | Checkpoint | What a reviewer should look at |
| --- | --- | --- |
| `d8b5472` | CI gap fix | Adds the compatibility-rollout proof as the **last** integration step (it advances the singleton release pointer; ephemeral CI container makes that safe). Verified locally on a disposable database. |
| `4c8d492` | Pool hygiene | Extracts one fail-closed `withTenantScopedClient` primitive into `workspace.ts`; connections + authoring adapters delegate to it (their private helpers had no pre/post context assertions, no read-back verification, no destroy-on-leak). New 5-test real-Postgres suite `tenant-context-hygiene.integration.test.ts`. See deviation D1/D2. |
| `1b8af29` | Lint gate | Root lint got `NODE_OPTIONS=--max-old-space-size=8192` (typed ESLint OOM'd at Node's default heap — tracker line 1539 recorded the symptom). Restoring the gate surfaced and fixed one latent violation in `apps/api/test/node-testing/validation.test.ts`. See deviation D3. |
| `364bc1a` | This document | Findings 1–6 recorded with evidence. |
| `ce02e52` + `81ff6c9` | Connection box closed | Concurrent-race proofs: exactly-one-winner same-name creates; CAS rotation from one expected pointer admits exactly one winner regardless of race order; losers leave zero orphaned secret versions. Closes the last unchecked connection-slice box. |
| `bd2989b` + `0e75643` | ADR 007 box closed | Executor-boundary truth for rate-limit / timeout / canceled under the manifest-pinned `unsafe` class (policy layer already covered all three side-effect classes). No production code changed — tests only. |
| `21a0b1d` | Initial preview seam | Added checksum-bound delivery validation, fenced claims, heartbeats, completion, and a first reconciliation seam. Its reconciliation semantics were incomplete by side-effect class and are corrected by `5dfb5f0`. |
| `2c1418a` | Initial preview composition | Added the handler, invoker, queue router, and output validation. Review found mapping, release-identity, unsafe-deadline, production-composition, capability, and cleanup defects; do not review this commit without its corrective successor `dd0d665`. |
| `f434f71`, `8683011` | Tracker pairs | Evidence-ledger updates in the repo's feat→docs rhythm. |
| `886cdb3` + `cf26f87` | Real-transport proof | Acceptance → outbox → BullMQ → routed consumer → pinned `core.set` executor → truthful succeeded; atomic inbox receipt; exact redelivery is a byte-identical no-op. The suite activates this artifact's derived release through the full audited maintenance flow instead of trusting the migration bootstrap fingerprint. See deviation D8. |
| `abe757f` + `4cce3cf` | Unsupported sweep placeholder | Added a job kind with no consumer or authorized serving role. This was not a valid capability and is removed by `dd0d665`; Finding 7 records the correction. |
| `dd0d665` | Preview correctness repair | Reuses production input mapping, aligns API/worker release identity, fixes unsafe deadline truth and heartbeat lease-loss behavior, composes preview-only readiness plus JIT capabilities, closes startup failures, and removes the unsupported sweep contract. |
| `5dfb5f0` | Reconciliation truth repair | Reclaims undispatched, safe, and stable-key expired deliveries while reserving `outcome_unknown` for unsafe possibly-dispatched work; automatic reconciliation delivery is still open. |
| `d44ce6b` | Mapping-cancellation truth repair | Maps the workflow engine's pre-dispatch `attempt_aborted` decision to the canonical canceled preview outcome, proves the executor is never invoked, and makes the already-required durable preview store explicit in the composition type. |
| `b850f53` | Automatic reconciliation delivery | Commits a fence-bound delayed maintenance outbox delivery with every preview claim; the PostgreSQL decision reschedules live leases, fences and redelivers reclaimable work, stops at the deadline, or records unsafe ambiguity. Exact duplicate receipts are no-ops; real PostgreSQL/Redis transport is proven. |

### Verification summary

- The corrected documentation head `d3f1397` passes repository-wide
  `pnpm check` (format, lint, generated-contract drift, typechecks, unit suites,
  production builds).
- Fresh-isolated-database integration matrices were run repeatedly before the
  corrective review (latest recorded state:
  artifact-store 2, database 230+, worker 10+, API 7 assertions) with the
  disposable database dropped and the shared development database untouched;
  the corrected-head matrix then passed with artifact-store 2, database 230,
  worker 11, API 7, and the rollout assertion last. The known shared-DB `0012`
  checksum drift (Finding 4) is why local full runs use the fresh-database
  procedure.
- Focused suites added or extended by this session include tenant-context
  hygiene 5, preview persistence/reconciliation 6, preview handler 13,
  platform preview invoker 3, preview real transport 1, and connection
  concurrency +2. Counts are fixed-head evidence and will be regenerated at
  the final gate.
- At fixed implementation head `d44ce6b`, repository-wide `pnpm check` passes,
  including all 98 worker assertions. Independent Standards and Spec reviews
  report no remaining blocker/high finding for merging this explicitly gated
  foundation; both reviews retain the Phase 4 activation blockers below.

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
  preview output streaming is NOT landed yet. Production capability factories
  now reach the preview runtime, but the handler still needs an artifact-output
  policy before ADR 016 parity can be claimed.
- **D5 — Classification ownership.** For previews the injected invoker owns
  executor error classification. The persistence seam now distinguishes
  reclaimable undispatched/safe/stable-key work from unsafe ambiguity. Commit
  `b850f53` adds the automatic durable delivery path: PostgreSQL atomically
  schedules and decides fence-bound maintenance wake-ups, while BullMQ retries
  remain transport recovery rather than business-retry authority.
- **D6 — Deadline source.** The retention `expires_at` doubles as the
  current bounded execution deadline and artifact lifetime. This is an interim
  implementation constraint, not a completed timeout/retention design; a
  separate pinned timeout policy may be required before activation.
- **D7 — Identity conventions.** Preview runtime maps
  `attemptNumber = 1` and `invocationKey = preview:<nodeId>`; these are new
  conventions introduced by this branch and should be ratified in a follow-up
  ADR note if adopted.
- **D8 — In-test activation.** The transport proof performs a real
  maintenance prepare/probe/preactivate/approve/activate cycle against the
  seeded predecessor. This uses only audited production seams but means the
  test database ends on the artifact's cohort release — safe because the
  database is disposable.
- **D9 — Retention.** No deletion path was landed. The unsupported placeholder
  job was removed because a capability must not be advertised before its
  authorized role and consumer exist. ADR 016 and the Phase 4 tracker still
  require the short-retained preview/artifact lifecycle before activation.
- **D10 — Contract additions.** The `delivery` parameter on
  `completePreviewAttempt` is retained because inbox completion must commit
  atomically with the terminal outcome. The abandoned sweep queue additions
  are not part of the resulting contract.

### Remaining before Phase 4 can be marked complete

1. Prove pre/post-dispatch SIGKILL boundaries across all three side-effect
   classes through the automatically delivered reconciliation path.
2. Add artifact-backed preview outputs with retention inheritance and an
   authorized bounded deletion lifecycle for preview rows and owned artifacts.
3. Persist terminal audit/usage facts and emit bounded preview metrics/traces.
4. Prove prior-preview scope/expiry and safe status reads over the real HTTP
   stack, including cancellation/timeout behavior.
5. Prove `http.request@1` additive activation with live JIT connection and
   artifact capabilities while retained releases continue executing exactly.
6. Run the fixed-head repository-wide and complete real-service regression
   matrix, then complete independent Spec and Standards reviews before any
   Phase 4 completion or production activation claim.

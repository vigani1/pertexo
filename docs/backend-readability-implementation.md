# Backend readability implementation ledger

Status: **complete**, subject to the qualification evidence named below.

This ledger implements [the readability plan](backend-readability-plan.md)
against the immutable [candidate inventory](backend-readability-inventory.json).
It records rollout scope, protected behavior, verification, and final candidate
dispositions. Candidate coordinates are snapshot anchors; final reconciliation
lives in `backend-readability-dispositions.json`.

## R00 — baseline and reconciliation

- Implementation baseline: local `main` at `c5ad9da5`, six commits ahead of
  `origin/main`, with a clean working tree before this ledger was created.
- The Q9 implementation and planning work predate this implementation stage.
  They are preserved in commits `c7e95a25` and `c5ad9da5`.
- A fetch confirmed that the branch was not behind or diverged. The authorized
  push was rejected by the remote branch-protection rule (GH013: pull request
  and required checks); no bypass, force push, or history rewrite was attempted.
- Inventory `schemaVersion: 1` remains immutable. Its snapshot covers 1,220 code
  files and contains C001–C131 and F001–F364.
- Q9 moved the implementation represented by F005 into explicit stream-cleanup
  closures, moved F185 into the migration failure aggregation path, and moved
  F295/F296 into explicit HTTP body ownership. F025 and F300 remain test-suite
  callback anchors. These IDs are reconciled by symbol/replacement locator and
  are not discarded.
- Dispositions use `changed`, `retained`, or `blocked`. A retained record names
  the invariant or ownership proof that would be obscured by further extraction;
  passing metrics alone are never the reason.

## Workstream ledger

| Slice | Owner and finite rollout set | Chosen shape and protected behavior | Status / verification |
| --- | --- | --- | --- |
| R00 | This ledger; immutable inventory; all current C/F symbol owners | Keyed reconciliation plus final-source rescan; preserve pre-existing commits and branch state | complete — 495 baseline and 41 new-finding records, no blocked items |
| R01 | `report-risk-coverage.mjs`; performance producer/comparator; HTTP exercise; ECS deployment validator; their direct tests and check commands | Ordered private validation phases; preserve versions, failure precedence, independent evidence calculations, fail-closed policy, and bounds | complete — direct infrastructure suites and owning checks passed |
| R02 | database operator readiness, platform readiness/probe, capability/grant siblings and tests | Snapshot acquisition remains single; named role, grant, release/schema, and capability assertions retain SQL/query order | complete — public runtime negative matrix and readiness tests passed |
| R03 | workflow-engine operation/checkpoint/executable validation; workflow-model graph/schema validation; compatibility consumers | Domain-named identity/admission/invariant phases only where they reduce mental execution; preserve V1/V2 distinctions, first failure, cached traversals and bounds | complete — checkpoint phases moved to one private module; focused and full coverage suites passed |
| R04 | API OIDC adapter, API runtime source/config refinement, all six app config/bootstrap validators | Separate syntax/bounds, binding and scope rules; share only identical pure config policy; preserve issue paths, defaults and security gates | complete — request policy module plus runtime-source staging; OIDC/bootstrap tests passed |
| R05 | four command/recovery runners; API startup; queue consumer; artifact store/ledger; quality/benchmark/Postgres runners; all six app mains | Local ordered cleanup and explicit primary/cleanup failure state; preserve all-attempted vs fail-fast order, sync close, undefined rejection, timeout and idempotence | complete — local owners changed selectively; already-clear owners retained with keyed reasons |
| R06 | production/preview attempt handlers and node runtime artifact capabilities | Handler-local heartbeat/outcome phases and visible spool/upload/finalize ownership; no mode-flag framework | complete — distinct production and preview supervisors plus artifact policy/spool phases; 104 focused tests passed |
| R07 | API connection testing and webhook ingress | Provider transport behind a normalized local result; named admission/authentication/parsing/persistence/response phases | complete — provider and webhook phases retain credential zeroization and admission order |
| R08 | coordinator observation loading and failure-notification completion | One repeatable-read observation proof; small private completion decision; preserve bounds, query order, ambiguity and atomic mutation | complete — retrospective public-store query characterization and completion-policy matrix passed |
| R09 | migration runner and database config | Explicit advisory-lock/session owner and execution phases; compare role config before local extraction; preserve combined failures and append-only SQL | complete — discovery/plan and execution-mode phases remain under one session owner |
| R10 | eight retention maintenance loops and worker outbox dispatcher | Extract only narrow timing/recovery mechanics; local claim/publish/settle phases; preserve readiness, backoff, capacity and bounded drain | complete — all eight loop decision matrices, delay cancellation, and outbox settlement phases passed |
| R11 | Slack/email/secure HTTP; remaining artifact/queue/rate-limit lifetimes | Package-local credential/body/redirect phases; preserve fence policy, SSRF, deadline, uncertainty and zeroization | complete — credential owners, request admission, redirect/final response, and named dispatch context implemented |
| R12 | node SDK registry release successor and compatibility consumers | Definition and executor successor phases with typed models and original first failure | complete — 35 SDK and 15 catalog tests passed |
| R13 | owning slices plus complete literal-occurrence search | Unit-bearing local policy names; no global constants bag and no unification based only on equal values | complete — complete occurrence search and owner-local constants recorded |
| R14 | every test candidate, test support, database pool fixtures and embedded subprocess programs | Retain scenario/oracle visibility; reuse only identical mechanics in existing fixture owners | complete — opaque benchmark programs became separate-process fixtures; test-suite callbacks retained explicitly |
| R15 | every repository area and non-AST source family; final rescan and qualification | Manual closure plus keyed dispositions; no metric concealment, widened exemption or generated/history rewrite | complete — manual closure, independent read-through, unchanged complexity ratchet, final scan and qualification |

## R05 ownership and error table

This table is the required pre-edit ownership model. “Primary wins” means the
original operation error remains the returned/thrown identity while cleanup is
still attempted; owners that aggregate cleanup failures retain their existing
aggregate shape.

| Owner | Resources / partial state | Normal and abort release order | Failure contract to preserve |
| --- | --- | --- | --- |
| lifecycle command `run` | signal listeners, database runtime, telemetry | stop accepting work; close runtime; flush telemetry; detach listeners | primary wins; best-effort fallback remains visible |
| operator command `run` | signal listeners, operator runtime, telemetry | abort command; close runtime; flush telemetry; detach | primary wins; `undefined` rejection is still failure |
| recovery `restoreBeforeServe` | pool/client/session work, telemetry | finish/abort restore; release database owner; flush telemetry | preserve restore error and attempt every required cleanup |
| retention `run` | maintenance loops, abort/signal state, database and telemetry | stop loops; close database; flush telemetry; detach listeners | retain ordered shutdown, timeout and repeated-close behavior |
| API `createApiApplication` | Nest app, database/runtime dependencies, partial startup stages | reverse only acquired stages; app/runtime closure before telemetry finalization | startup error remains primary; no leak on partial construction |
| queue consumer `process` / `performClose` | message lease/heartbeat, abort state, consumer connection/timer | stop new work; settle owned attempt; join heartbeat; disconnect | completion/lease error precedence and bounded close remain unchanged |
| dual-region artifact store / control ledger `close` | primary and secondary regional clients | sequentially attempt both in documented order | both closes attempted; aggregate/primary identity retained exactly |
| local quality runner | child processes, services, evidence writers, signal handlers | terminate owned children; collect diagnostics; stop services; detach | first run failure plus cleanup evidence; no hidden child remains |
| benchmark round / benchmark | pool, participants, barriers, evidence temp/output | release round waiters/clients; close pool; write/clean evidence as currently ordered | pending waiters remain observable; evidence failure precedence retained |
| Postgres contention samples | pool clients and blocked waiters | release checked-out clients, drain waiter, end pool | all release/end errors retained; no waiter hidden |
| six `main.ts` bootstraps | partially created app/runtime plus signal process hooks | call the locally owned fallback close only when construction reached that stage | best-effort cleanup must not replace the bootstrap error |

## Policy and constant ownership

| Meaning | Owner and runtime consumers | Literal expectations intentionally independent |
| --- | --- | --- |
| connection test timeout, milliseconds | API connection-testing use case; email, Slack and HTTP dispatch consumers | provider outcome fixtures may keep explicit boundary values |
| webhook freshness allowance, seconds | webhook ingress authentication timestamp comparison only | database-clock and stale-boundary cases retain wire timestamps |
| integration evidence schema version | risk-evidence producer/validator only | incompatible-version fixtures remain literals |
| benchmark evidence schema version | local benchmark producer and comparator runtime contract | legacy/invalid fixtures and manifest versions remain explicit |
| Q11 operation marker and timing schema version | existing parser/protocol owner and all emitters | invalid/legacy subprocess fixtures remain explicit wire text |
| contention rounds/waits/thresholds | local Postgres performance measurement owner | asserted threshold remains independent of measurement calculation |
| exercise entry/header/problem bounds | HTTP exercise validator owner | invalid-boundary fixtures retain distinctive values |

## Slice outcomes and protected behavior

### R01, R04, and R13 — ordered policy

- `report-risk-coverage.mjs` now admits producer/result/source identity before
  interval traversal and hashing, and names suite containment separately. The
  comparator separates manifest shape, scenario population, operation evidence,
  process/database observations, participants, overlap, and environment. The
  benchmark producer mirrors those phases without importing its independent
  oracle from the comparator.
- The HTTP exercise separates response-code semantics from header collection
  shape and per-header restrictions. ECS capacity, cooldown, and signal checks
  are named without changing the external workload contract.
- OIDC authorization bounds, registered binding, syntax, and scope policy execute
  in their former order in `oidc-request-validation.ts`; token exchange retains
  its separate `identity.provider_rejected` contract. API runtime dependencies
  are read only after the corresponding feature runtime proves unavailable.
- New constants remain with their policy owner: connection-test milliseconds,
  webhook freshness seconds, OIDC byte/character bounds, exercise bounds,
  distinct integration/benchmark schemas, and Postgres measurement values.
  Literal searches covered runtime consumers and deliberately independent test,
  compatibility, SQL, YAML, and image-pin values.

### R02, R03, R08, R09, and R12 — consistency proofs

- Operator readiness acquires one typed snapshot, then performs release, role,
  membership/direct-grant, and capability assertions in the original order.
  Platform readiness keeps its narrower CRUD and forbidden-grant policy and its
  cancellation-before-deadline precedence.
- `checkpoint-executable-validation.ts` owns join identity, invocation graph
  membership, iteration scope, admission, and loop identity/topology. It reuses
  one parsed checkpoint, one flattened node set, and existing cached graph
  context. V1/V2 and legacy root-join allowances stay explicit.
- Coordinator observation loading remains one repeatable-read operation with
  unchanged SQL/query order and bounds. Persisted facts, pending failure rows,
  invocation binding, physical state, control state, artifacts, and wakeups are
  visible phases. Pending failures are validated and appended directly, without
  an intermediate batch. `completionDecision` isolates failure-notification retry
  versus terminal policy before the existing atomic persistence/outbox/audit
  mutation. Because extraction had already happened, the public-store query
  sequence tests are explicitly retrospective characterization: they compare the
  current phases with the pre-refactor owner and assert semantic query kinds
  rather than SQL whitespace. Normal and 1,001-fact loads prove one client and
  one repeatable-read transaction, including two 1,000-row page requests;
  not-found, corrupt-checkpoint, and canceled loads prove that later observation
  queries do not execute. Existing bound cases continue to protect the 10,000-
  fact ceiling.
- Migration discovery and execution-plan selection are separate from the one
  advisory-lock/session owner. Pool size, role/reset/unlock order, checksums,
  resumability, rollback, observer isolation, and combined failures are unchanged;
  no historical SQL was edited.
- Registry successor validation has separate typed definition and executor
  phases. Lifecycle tables, immutable behavior projections, retirement-before-
  removal, staged/active entry rules, epoch continuity, fingerprints, and first
  failure remain authoritative.

### R05, R06, R10, and R11 — resource ownership

- Command and recovery paths now name dispatch/restore and ordered cleanup while
  retaining primary-error identity, undefined rejection handling, timeouts, and
  all required cleanup attempts. API partial-startup, dual-region synchronous
  closes, the six bootstrap fallbacks, telemetry isolation, and existing Redis
  owners were retained where their local ownership proof was already clearer
  than another abstraction.
- Production attempt supervision owns heartbeat stop/join, durable abort, lease
  failure, and its derived execution signal. Preview supervision remains a
  distinct deadline/lease race. Neither path acquired mode flags or a callback
  framework. Runtime construction and dispatch-fence translation live beside the
  corresponding handler.
- Artifact writes read as bounded spool and zeroization, pending record, upload,
  metadata verification, finalize, and directory cleanup. No body copy was added;
  upload/finalize receive only their original metadata fields.
- `runOperationLoop` shares only retention timing, recovery/backoff, cancellation,
  and poll delay. All eight operation functions retain their metrics, recovery-
  before-log order, progress meaning, and immediate-continue decision. Outbox
  claim observation, publish, settle, failed-publication release, and summary are
  named while capacity scheduling and settlement order remain local. A 34-case
  table at the public worker seam enumerates the applicable idle, progress,
  status, deletion, and capacity outcomes for operator rerun, scheduling,
  transient-data reaping, dry run, enforcement, preview retention, run-artifact
  retention, and workspace purge. Fake-timer cases separately prove cancellation
  during poll delay and failure backoff without another operation call.
- Slack/email credential owners parse and always zeroize secrets but keep their
  unsafe/idempotent outcome rules separate. Secure HTTP has one request-admission
  module plus visible resolution, dispatch marker, redirect, final-body, and close
  phases. `DispatchFailureContext` replaces ambiguous boolean pairs without
  changing SSRF, deadline, body, closure, or possibly-dispatched semantics.

### R07 and R14 — boundary and test readability

- Connection tests normalize provider transport results, then retain common
  claim, credential lifetime, dispatch marking, completion, and abandonment.
  Webhook admission remains rate-limit before freshness, current/previous secret
  verification before JSON parsing, and durable acceptance before response
  mapping.
- The failure-notification public-store test covers every policy axis and material
  intersections, including unsafe prior uncertainty and invalid claimed results
  before mutation. Operator runtime negatives cover wrong role, forbidden
  membership, direct grants, missing capabilities, and unsupported release.
- Two embedded benchmark child programs became standalone fixtures while
  preserving separate-process execution, barriers, environment/timing identity,
  and injected failures. Existing database support owners were reused; role-
  specific pool setup and scenario/oracle values remain in their tests.

### R00 and R15 — reconciliation and retained complexity

- `backend-readability-dispositions.json` lists every C001–C131 and F001–F364:
  63 changed, 432 retained, and 0 blocked. It also records 41 same-family/new-
  source findings and replacement locators for moved Q9, secure-request, and
  checkpoint owners.
- Retained candidates protect one of these concrete shapes: a transaction/lock
  proof, bounded parser/traversal with first-failure diagnostics, domain state
  machine, resource owner, fail-closed security boundary, declarative composition
  root, test fixture/oracle, or cohesive public facade. The keyed file names the
  applicable reason for every individual candidate; no metric result is used as
  the reason.
- A final complexity-gate failure exposed helper growth in already-large files.
  Cohesive policy/supervision/checkpoint phases were moved into private local
  modules, and the unchanged complexity baseline then passed. No threshold,
  exclusion, coverage rule, or baseline allowance was widened.
- The final-source scan covers 1,549 tracked-or-nonignored files and 1,235 code
  files. It reports 110 conditions (108 production, 2 test) and 352 functions
  (95 production, 257 test), versus 131 and 364 in the immutable baseline. Its
  code-source SHA-256 is
  `57624205fbee224435541c3ac678b560bc96fac98c51bad9e88d67a3ea2ac9a3`;
  all raw rows are in `backend-readability-rescan.json`. The reduction is
  evidence, not the completion criterion.

## Area closure checklist

Each row is closed only after flagged candidates, unflagged neighboring code and
non-code assets have been inspected. “Retained” still requires keyed reasons.

- [x] root, CI, build/test/lint configuration and current documentation
- [x] API controllers, guards, use cases, runtime construction, config and tests
- [x] worker execution, transport, runtime, support and tests
- [x] lifecycle-command, operator-command, recovery and retention apps
- [x] database authoring, compatibility, connections, execution, lifecycle,
      operator, platform, triggers, migrations, SQL interfaces and test support
- [x] workflow-engine and workflow-model
- [x] artifact-store, contracts, integrations, node-catalog, node-sdk, nodes-core,
      observability, queue and rate-limit packages
- [x] infrastructure root runners, performance, exercises, ECS, Postgres, MinIO,
      observability, shell scripts and operational assets
- [x] generated contract artifacts, fixtures, embedded scripts, SQL, YAML and JSON

## Verification evidence

Focused checks were run at each seam before the final gates:

- R01: risk report/comparator tests (41), benchmark producer tests (33), HTTP
  exercise tests (8), the complete performance suite (50), `exercise:check`, and
  `deployment:check` (30 tests plus validators) passed.
- R02/R08/R09: database typecheck, readiness tests, the public operator negative
  suite, failure-notification policy matrix, and migration runner/plan/checksum
  suites passed. The four retrospective query-characterization cases in
  `packages/database/test/coordinator-run-store-observations.integration.test.ts`
  passed under `pnpm quality:local -- --partial integration-database` (418/418
  tests), covering normal and paginated query sequences plus not-found, corrupt-
  checkpoint, and cancellation cutoffs. `pnpm --filter @pertexo/database
  typecheck` also passed. Service-backed observation, scheduling, readiness,
  RLS, transport, migration-mode, and repair suites are included in final local
  qualification.
- R03: focused operation/checkpoint/foreach/nested-parallel/bounded-work tests
  passed after the final module split. The workflow-engine coverage run passed
  306 tests and its aggregate and stronger pre-expansion threshold groups;
  model and database consumers are covered again by the full gates.
- R04/R07: the OIDC boundary selection ran 40 passing cases after the final
  split; API bootstrap,
  connection, credential-boundary, controller, telemetry, webhook ingress, and
  direct-webhook suites passed in their owning and final runs.
- R05/R06/R10: command/recovery/queue focused suites passed; the 34-row loop
  matrix and two cancellation cases in `apps/retention/test/run.test.ts` passed
  under `pnpm --filter @pertexo/retention exec vitest run test/run.test.ts` (44/
  44), and `pnpm --filter @pertexo/retention typecheck` passed. The final worker
  selection ran 104 attempt, preview, artifact-runtime, and outbox tests, and
  the final queue consumer selection ran 17 tests.
- R11: the final secure-HTTP selection ran 89 passing tests; Slack, email,
  HTTP-request, and outcome-policy suites passed in the package run.
- R12: registry tests ran 35 passing cases and catalog release history ran 15.
- R14/R15: dependency analysis recognizes both standalone benchmark fixtures;
  formatting, lint, build, and the unchanged complexity ratchet pass.

The extraction coverage audit confirmed that each extracted module inherited
the protection of its original selected owner: API priority coverage includes
`oidc-request-validation.ts`; worker coverage includes the artifact-policy,
attempt-environment, handler-state-error, and runtime-field modules; and both
workflow-engine aggregate and stronger groups include checkpoint executable
validation and output-reference comparison. `secure-http-request.ts` remains
covered by the integrations source-wide include. The database coordinator and
the worker preview-supervisor/outbox-result origins were not selected by the
respective focused cohorts, so their extraction did not remove inherited
focused protection. A scheduling branch threshold exposed one missing public
negative case; the unknown-branch regression restored it without lowering any
threshold or widening an exclusion.

The workflow-model regression also asserts the exact public `maxIterations`
diagnostic, and the database regression exercises direct pending-failure
accumulation, so both compatibility-sensitive readability corrections are
protected at their public seams.

`pnpm check` was run fresh on the final tracked/untracked source and passed every
formatting, documentation, runtime, local-runner, architecture, dependency,
schema, build/export, lint, complexity, duplication, contract, typecheck, and
test gate. The subsequent `pnpm quality:local` qualification used isolated owned
PostgreSQL, Redis, artifact, and dual-ledger services. Its stable source identity,
21 passed/0 failed/0 selected-skipped cohort result, 524 passed/0 failed/3 skipped
Vitest result, three named AWS-only skips, risk result of 0 unreviewed branches
across 466 reviewed branches, 137 selected files, and 5,658 coverable lines,
per-report totals, run ID, logs, performance evidence, and service-backed results
are preserved at
`coverage/local-quality/readability-final/qualification-summary.json`; the copied
manifest is `coverage/local-quality/readability-final/manifest.json`. These
ignored evidence files do not change the qualified source fingerprint.

An independent read-through checked validation short-circuit order, API runtime
source access, OIDC bounds, workflow join/iteration/loop precedence, readiness
query ordering, risk-evidence identity order, artifact metadata boundaries,
retention recovery/log order, and dispatch uncertainty. It found and prompted
corrections for eager later-field evaluation, leaked internal artifact fields,
generic recovery ordering, underrepresented retry/uncertainty intersections,
and ambiguous boolean pairs. The corrected paths were rerun through their focused
tests and final gates.

## Remaining limitations

- The protected `main` branch has not accepted the two already-created Q9/plan
  commits (`c7e95a25`, `c5ad9da5`); the authorized push was rejected by GH013.
  No bypass, force push, rebase, or history rewrite was attempted.
- The three production AWS S3 Object Lock/bucket-policy cases cannot be
  represented faithfully by local MinIO and remain explicitly skipped in the
  qualification manifest. All selected local cohorts passed.
- Scanner counts are threshold-based discovery signals. The 110 remaining
  conditions and 352 remaining functions include deliberately retained bounded
  parsers, transaction/state-machine proofs, resource owners, and test scenario
  containers; they are not asserted to be universally simple.
- This implementation stage is intentionally uncommitted and unpushed.

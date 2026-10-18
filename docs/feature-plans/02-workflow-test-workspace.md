# F02 — Run-input cases and pinned samples

Status: slices 1/2 and whole-draft tests delivered (#324); slice 3 delivered (#333).
Updated: 2026-10-17. [Roadmap](../product-roadmap.md).
Decisions: [ADR 061](../adr/061-workflow-input-cases-and-checked-manual-start.md)
and [ADR 080](../adr/080-draft-step-samples.md). History stays in git.

## Current code and ownership

Run-input cases and checked real starts are delivered (#145). The editor tests
one saved draft step through `api/node-testing`, durable database previews and
worker execution. Its Run command starts a published version. Keep these
separate; no new test engine or published-run override.

Shared workflow-model owns sample identity; the existing stored-value boundary
owns run-data JSON bounds. Database/authoring/step-samples owns persistence and
source reads; database/previews owns atomic
substitution and history. Node-testing owns HTTP. The web workflow-publish Test
panel owns sample management; workflow-editor displays its state on steps.
Existing retention, workspace purge, contracts and boundary checks are extended.

## Slice 2 decisions

The owner authorized pins on 2026-10-16. Recommended details below resolve the
old plan's open choices against current code; ADR 069 supersedes its old legal-
hold, release-cohort and production-enablement machinery.

- One shared pinned sample per draft step, created from pasted JSON or a
  successful authorized preview/run step in this same workflow. A specific node
  run identifies a loop iteration. Save copies data; deleting/expiring its source
  never changes the sample. Store provenance IDs, not provider messages.
- Pins live outside the graph. Publishing, Run published version, replay,
  recovery, child Calls, export, import and duplication never read/copy them.
  Existing isolated editor Test runs and previews use them automatically.
- Pin only ordinary inline JSON under the existing stored run-value bounds:
  256 KiB for its JSON value, depth 64 and 10,000 members. Reject
  non-JSON, malformed storage text, file/artifact-backed outputs and nested file
  references clearly. Read file can first turn a file into bounded JSON. Binary
  sample retention is later work; never save a dangling file reference.
- Identity includes definition key/version, config version/config, input
  mappings, connection references and enabled state. Labels, position and links
  do not invalidate an intentionally fixed output. One shared canonical identity
  function serves API/database/web; no second list of node types or hash helper.
- Changed setup marks a pin stale immediately in the editor. A stale or expired
  pin cannot execute a test or silently fall through to a provider call. Confirm
  an unexpired stale pin for the current saved setup, replace it, or remove it
  explicitly to test the real step. Expired data must be supplied afresh.
- A matching pin returns its saved output without validating unused provider
  settings/mappings, resolving credentials, creating an execution attempt or
  dispatching work. Its durable preview succeeds with `pinned` provenance,
  no start time and no invented execution duration. Preview history and the
  editor clearly say **Pinned**; setup/publication validation stays real.
- New test commands freeze the expected sample ID (or explicit absence) with
  input, draft revision and idempotency key. Under one admission transaction,
  current authority, locked draft/setup and expected pin must still match.
  Removal/expiry/change during admission refuses instead of dispatching.
  Accepted-receipt recovery precedes mutable pin/source checks, returning the
  original output after response loss. Legacy omitted fields retain hash bytes.
- Reads require workflow-read and run-read authority; management requires current
  workflow-update authority too. Owners/admins/builders manage; naming/creator
  attribution grants no special access. Active workspace/user/member checks and
  same-workspace source checks are repeated under the shared authority locks.
  Archived workflows are inspect-only. No public or API-token testing authority.
- Samples expire 30 days after explicit save/confirmation, matching retained run
  data; remove/replacement erases that sample payload immediately. The preview
  copy has the existing seven-day preview lifetime. No source-row foreign key
  extends source visibility or retention. No payload in logs, audit, receipts,
  notices or exports; warn that samples are shared run data, not secret storage.
- One table stores the current sample with the existing inline value format.
  A fresh opaque ID on replacement/confirmation is its compare-and-set token.
  No payload revision archive, legal hold, new format number or second store.
  Retain exact command receipts through the existing 24-hour window. Metadata
  and quota mutations serialize with authoring authority and the saved draft.
- Bound storage to 200 pins/workflow (the graph node cap), 1,000/workspace and
  16 MiB of actual retained signature/value bytes per workspace. Expired rows
  still count until erased. Replacement charges the net bytes atomically; a
  deleted payload releases its charge. These are bounded authoring quotas,
  following input cases, not a billing meter or new subsystem.
- Existing maintenance retention removes expired rows in bounded pages. Draft
  replacement removes pins for deleted steps; workspace purge removes pins before
  workflows. Current pins survive cosmetic draft edits; restoring a version
  retains only samples whose step still exists, with normal stale checks.

## HTTP and frontend

- Metadata list under `/workflows/:workflowId/draft/samples`; one step's payload
  and commands under `/draft/nodes/:nodeId/sample`. GET is private/no-store.
  PUT accepts pasted/source output or explicit confirmation with saved draft
  revision, expected sample ID and Idempotency-Key. DELETE has the same locked
  expected-ID/draft precondition. Strict contracts and ordinary CSRF/rate limits.
- The canvas and Test panel share one scoped metadata query. Fetch a sample's
  value when its dialog opens; selecting a step does not fetch its output.
- Use feature-local API/query/mutation owners and existing retained-command
  behavior. Freeze uncertain commands; preserve pasted JSON on conflicts and
  provide exact retry. Scope changes/authority loss clear forbidden data and
  fence late results. Refetch after a definitive change rather than overwriting
  another editor's sample.
- The Test panel offers Pin output, paste JSON, confirm stale and remove. Its
  Runs tab offers Pin output on retained successful step executions. Reuse
  JSON input/tree, Dialog, Status and buttons. Step badges distinguish pinned,
  stale and expired; show the original source and expiration. Pinned tests
  explain that the step is not called and need no provider-effect promise.
  Unpinned tests retain explicit real-effect acknowledgement.
- Phone, keyboard and reduced-motion behavior follow existing Weft components.
  No new design system, global sample store, graph editor mirror or binary viewer.

## Whole-draft tests (2026-10-16)

The owner now authorizes **Test workflow**, separate from the published Run
command. Whole-draft execution extends single-step previews and shared pins,
reusing the engine, coordinator, attempt workers, run events and admission
counters. The API and browser never execute the workflow.

### Admission and ownership

- The node-testing API owns `/workflows/:workflowId/draft/tests`: prepare the
  saved revision, start with an idempotency key, list retained tests, inspect and
  cancel one. Session-only; require current workflow update, workflow read,
  run read and run start authority. Archived workflows cannot start tests.
- Freeze the exact saved draft revision, compiled executable, current variable
  revision and matching pin IDs/outputs in one admission transaction. Recheck
  authority, revision, pin identity and expiry under the existing authoring locks.
  A stale/expired pin refuses the test, never falls through to a real call.
  The coordinator loads pin identities only; each worker reads only its own
  frozen sample, keeping unrelated pin payloads out of per-step reads. Preserve each sample’s existing encoded execution value inside the snapshot,
  so PostgreSQL cannot inflate numeric exponents in a nested JSONB payload.
  Accepted command recovery precedes mutable draft/pin checks.
- Keep a test snapshot alongside the ordinary execution rows, explicitly marked
  by trigger type `test`. Its executable identity is the snapshot ID, never a
  published version. Published version readers remain publication-only; worker
  execution readers resolve either immutable source. No fake publication, no
  incremented publication number and no test overrides on real-run commands.
- A partial unique index enforces one queued/running/waiting test per starter
  and workflow, including different API instances. Ordinary workspace/workflow
  queue and active capacity admission applies. Tests have a five-minute execution
  budget including queue time and retries, capped by a shorter draft run budget.
  Cancel uses the existing fenced
  run cancellation. One person may test a different workflow concurrently.
- Input is bounded run JSON selected from a saved input case, the trigger's
  matching pinned sample, or pasted JSON. Loading a case makes a detached copy;
  its published-version context does not change this command into a real run.
- Preparation lists every enabled unpinned step that can cause external effects,
  including loop bodies and alternatives. Admission requires the same explicit
  effects acknowledgement as individual tests and rechecks the exact list.
  Pins skip credential resolution, mapping evaluation and executor dispatch.

### Execution and isolation

- Execute the original graph with the existing engine's branches, failure links,
  joins and loops. An injected engine compiler derives test admission facts and the first
  checkpoint under the storage locks. The database has no runtime engine import.
  A narrowly scoped test execution policy substitutes frozen
  sample outputs; it is not another executor, engine or editable graph format.
  Preserve invocation identity so repeated loop results remain distinguishable.
- Wait completes immediately and records **Wait skipped in test**. Approval,
  Request input and Call use their pin. Without one, stop at that step with
  **Pin this step to continue the test**; never create a human task/child run.
  Respond to webhook never writes a response in a test.
- Tests never produce error-workflow intents, failure alerts, inbox notices,
  notification email, trigger outcomes or auto-pause streaks, even on unknown
  provider outcomes or worker reconciliation. Live execution events remain for
  the editor. Effectful unpinned steps still execute genuinely and retain the
  ordinary dispatch, retry, cancellation and unknown-outcome rules.
- Retain the copied input, graph, pins, outputs and private Code diagnostics for
  seven days, like previews. Extend existing cleanup, artifact references,
  variable revision retention and workspace purge, with no second value format.
  Tests are excluded from ordinary run lists, step health and activity totals.
  Expired test data cannot be pinned, replayed or recovered as a real run.

### Editor and evidence

- Add **Test workflow** beside published Run. Apply pending setup and flush the
  save coordinator first; keep the admitted revision visible if editing resumes.
  Use the existing bounded JSON/case controls and plain effects confirmation.
- Observe durable events through the current run stream, project step progress
  onto the existing canvas, and offer Cancel. Editor test history is separate
  from published run history, clearly labeled **Test**, with pinned/skipped
  provenance and Pin output for each successful retained step result.
- Preserve exact uncertain start/cancel commands and forbid accidental duplicate
  starts. Scope/permission changes fence late results and clear forbidden data.
  Verify phone/desktop, keyboard, reduced motion and reconnect behavior.
- Prove real PostgreSQL admission races, snapshot isolation, pin replacement,
  stale refusal, effects refusal, capacity, cancellation and seven-day cleanup.
  Exercise every suppression path, pinned control steps, Wait, human tasks,
  Calls, loops and Code. Keep the existing real HTTP adapter/worker qualification
  against a local fixture green. Qualify a
  browser/API/worker end-to-end test, pin a result and prove published execution
  still ignores pins. Run lint/types/unit/mocked e2e/build and React Doctor.

## Slices and status

| Slice | Status |
| --- | --- |
| 1. Named run-input cases and checked published starts | Delivered (#145) |
| 2. Bound draft samples, atomic preview substitution and editor/history | Implemented |
| Whole-draft tests and live editor test history | Implemented |
| 3. Suites, assertions and batch regression | Implemented and locally qualified; green CI before merge |

## Required evidence

- Shared identity ignores cosmetic changes and invalidates every behavior field;
  exact size/depth/member/storage-text bounds, provenance and no-file errors.
- Real PostgreSQL authority/RLS, source read isolation, CAS/idempotency, quotas,
  source expiry, pin expiry, cleanup/purge and populated migration upgrade.
  Race pin replacement/removal and draft edits against admission; prove no
  execution attempt/outbox/provider call for pinned or refused stale commands.
- Exact retry after pin removal/source expiry returns its accepted pinned output;
  changed intent conflicts. Legacy preview commands and unpinned runs still work.
- Real browser/API/worker: pin a test output and pasted value, reload, consume
  it in a following test, change setup/confirm/remove, and start a real published
  run whose original step executes. Inspect durable pinned history and source
  facts. Test access loss/uncertain commands plus desktop/phone layouts.
- Full lint/types/build/unit/contract/schema/boundary checks, mocked e2e and React
  Doctor; green PR CI before rebase merge. Matching readers/writers deploy
  together; existing exact migration-head readiness refuses mixed writers.

## Shared run policy follow-up (2026-10-17)

Status: delivered in #333 (2026-10-17); exact-head CI and all browser lanes passed.

Keep test classification and run-data lifetimes in `database/runs/data-policy`.
Use shared SQL fragments for lists, statistics, retained reads and maintenance,
plus the same discriminator and test lifetime for TypeScript decisions and test
snapshot creation. Keep schema vocabulary declarations as stored constraints.
No stored retention date, migration, new query mechanism or public entry point.

Preserve current semantics exactly: tests expire seven days after creation;
ordinary details retain their existing 30-day window and ordinary summaries
90 days after completion. Preserve each read's existing statement/clock timestamp,
completion checks and purge fences. Capacity continues to count tests; ordinary
run lists, activity statistics and failure-day history exclude them. Existing
preview/snapshot and source-run rules remain unchanged.

Qualification: existing reader, replay, preview, retention and capacity tests
stay unchanged. Add a database regression with ordinary and test runs across
statuses: workspace/workflow lists and every statistics projection exclude tests,
while the capacity read still includes them.

## Slice 3 — suites (2026-10-17)

The owner authorizes suites now. Reconciled against main after F29 #331 and
F12 #332. One suite is the workflow's active saved input cases, in existing
creation/ID order, run serially against one frozen saved draft. No browser-owned
execution loop, second test engine, new service, role or queue is introduced.

### Decisions and bounds

- Raise the active case cap from 20 to **50/workflow**. Preserve 200/workspace,
  64 KiB/input and the 4 MiB retained-payload workspace budget. Cases retain their
  existing published-version creation context; suites detach their inputs and
  execute the current draft, not that publication. Creating cases before a first
  publication remains later work.
- Each case defaults to expected **succeeds**, with up to 20 assertions (16 KiB
  aggregate expectation JSON/case, 4 KiB/expected value). Extend the existing
  immutable case payload revision with optional canonical expectation text.
  Charge input plus expectation bytes in the existing budget; omitted expectations
  preserve an edited case's settings. Existing cases keep their current charges
  and default to success with no assertions.
- An assertion selects the existing stored final output (a declared workflow result; ordinary workflows use a chosen step, with no implicit last-step rule) or a step, a platform JSON path (root `$`,
  own properties and array indexes; 512 characters/64 segments), and equals or
  contains. Reuse the shared parser and canonical JSON. Equals is structural JSON
  equality; contains is case-sensitive substring, a structurally equal array
  member, or object properties with equal values. No expression/pattern language.
  Reject identical duplicate checks; distinct contains checks on one path are allowed.
- A selected step must have exactly one retained successful invocation. Missing,
  unexecuted, repeated or file-backed output produces an explicit failed assertion;
  never silently choose a first/last loop result. Assert final output or add a
  downstream summary for repeated steps. Read at most two candidate invocations
  per selected step through an indexed workspace/run/node lookup; pin-required
  checks probe only frozen required-step IDs. Decode requested outputs through the stored-value
  owner. Do not download files or scan all execution history.
- Only terminal `succeeded` satisfies success, and `failed` satisfies expected
  failure. Unknown, timed-out and canceled outcomes cannot pass as expected
  failures. Business/expectation failures do not stop subsequent cases. Never
  automatically retry an unknown case as a new run. Canceling the current test
  stops its suite; explicit suite cancellation also fences that current test.
- Show pass/fail/error per case and expected/actual observations. Return full
  ordinary actual JSON up to 4 KiB; larger values have an explicitly truncated
  display and original byte count. Missing/unavailable/ambiguous are separate
  states, never invented null values. Summary reads contain metadata/counts only;
  fetch one case's bounded report on demand. Output/expectations are private run
  data, never logs, notices, exports or audit payloads.

### Admission, progress and storage

- Preparation uses existing draft/pin compilation, lists all unpinned effectful
  steps once, and adds ordered case IDs/revisions and the variable-set revision.
  Start rechecks these facts under current authoring authority and saved-draft
  locks, freezes cases/expectations, and requires one explicit effects acknowledgement
  for the whole suite. Recover an accepted idempotent receipt before mutable reads.
- Freeze graph/executable/pins **once per suite**, not once per case. Generalize
  existing `workflow_test_snapshots` to an independent source ID and workflow ID:
  backfill current rows, remove their originating-run ownership FK, and resolve
  test execution through each run's existing `workflow_version_id`. Keep the one
  existing snapshot/value format and published readers unchanged (ADR080 amendment).
  Standalone tests use the same source owner. Sources expire only after their last
  retained test reference; extending expiry changes no frozen behavior or data.
- New `workflow_test_suites` and ordered `workflow_test_suite_cases` store frozen
  source/variable revision, initial checkpoint in its existing format, case inputs,
  expectations and bounded results. Forced workspace RLS, existing app/maintenance
  roles, unique active suite per starter/workflow, unique case ordinal/run binding
  and existing command receipts fence races. No per-case copies of graph or pins.
- First case admission and suite creation commit atomically through ordinary run
  acceptance/outbox. Subsequent cases use the same acceptance owner, source,
  variables and initial checkpoint. Tests remain `test` and preserve all current
  effects suppression, pins, Wait/control behavior, capacity and seven-day rules.
- Extend the coordinator's existing bounded scanner with a PostgreSQL suite driver,
  using its existing app/maintenance pools. Discovery selects due active suites;
  each scoped transaction rechecks authority, takes the suite row, records the
  terminal case once, and admits at most one next test. A crash/repeated/concurrent
  scan cannot duplicate a case. No transition callback acquires authoring locks
  while holding a run row; retain workspace → actor/member → workflow/suite →
  source/variables → ordinary admission order. Cancellation takes suite before run.
- Recheck current starter authority before admitting another case; removal,
  suspension, lost capabilities or workflow archival stop further work visibly.
  An already accepted test settles under its existing controls. Queue-full waits
  retry after five seconds. Each test retains its five-minute maximum; a suite has
  a five-hour total bound, including capacity waits, then stops visibly.
- Show the latest 20 suites and retain private suite data seven days. Extend bounded
  retention, variable-set references, artifact reachability for frozen pending
  inputs, and workspace purge. Shared sources survive until all retained tests
  stop referring to them; add the necessary indexed test-source reference lookup.
  Active-suite and active-test exclusion apply together, including the gap between
  cases. All suite steps still run on ordinary workers.

### HTTP, editor and ownership

| Owner | Change |
| --- | --- |
| workflow-model/test-suites | Bounded expectation contracts, JSON-path comparison and observation rules |
| database/authoring/input-cases; schema/authoring | Expectations in existing payload revisions, 50-case cap and byte accounting |
| database/previews/workflows and suites | Shared snapshot admission/read; suite prepare/start/read/cancel/driver |
| database/schema/runs; lifecycle/variables | Suite/source constraints, RLS/grants, retention, purge and references |
| API node-testing/suites; contracts | Session-only prepare/start/list/detail/case-report/cancel under draft tests' existing authority/rate/CSRF rules |
| worker/runs runtime | Existing scanner drives bounded serial progress; ordinary outbox runs cases |
| web/workflows input cases | Plain expected-outcome/assertion fields, current step names and validation |
| web/workflow-publish | Run all tests, one effects dialog, case results/history and publish warning |

- Use `/draft/test-suites`: prepare, idempotent start (202), latest bounded history,
  suite detail, one case report and idempotent cancellation. Exact uncertain starts
  retain their original request/key. Session/scope changes clear private queries
  and fence late responses. Preparation/outputs stay private/no-store.
- Reuse plain dialogs, JSON inputs, Select, Status and existing command/query
  patterns. The suite view shows serial case progress and links to ordinary editor
  test results, where successful outputs can still be pinned. No second canvas
  state or global suite store. Keep phone, keyboard and reduced-motion behavior.
- Publish shows the latest shared suite result and warns for a failure or when
  draft revision, cases/expectations, pins (including expiry) or variable revision differ. Running,
  unavailable and never-run stay honest. This is advisory and never disables
  Publish. A cheap shared freshness owner compares metadata, without compiling
  the draft just to open Publish.

### Delivery and evidence

One implementation PR; no file moves currently required. Extend ADR080 and
ADR061 for the shared source and case-budget decisions. Use the coordinated
migration/readiness gate with matching readers/workers.

- Prove shared snapshot/variable/case isolation after edits, effects refusal,
  stale preparation, exact response-loss recovery, first/next admission races,
  restart recovery, mutual single-test/suite exclusion, queue waits, cancellation,
  authority loss and bounded expiry. Qualify 50 serial cases and storage reuse.
- Check equality/contains/path edge cases, missing/repeated/file outputs,
  truncation, expected failure versus unknown/timeout, output access and test
  effects suppression. Exercise worker/API/database end to end and actual browser
  setup/results/publish feedback on desktop/phone.
- Build, lint, types, unit, mocked e2e, contract/schema/boundary checks and React
  Doctor; green CI, then rebase merge before F14.

### Local qualification (2026-10-17)

- Whole repository unit suite: 9,501 Vitest tests plus Node checks; three new
  focused evaluator tests also pass. Case contracts/defaults, comparison bounds,
  report truncation and file-backed unavailability are covered.
- Real PostgreSQL: 40 admission/case/upgrade regressions, then the expanded
  14-case suite integration including frozen empty/nonempty variables and access
  loss. Fifty serial admissions share one snapshot; competing/restarted scanners
  admit each case once. Queue pressure, cancellation, suite deadlines, output
  ambiguity, report privacy, seven-day retention and maintenance purge pass.
- Populated 0025→0026 upgrade preserves existing test identity and old case byte
  charges, backfills workflow ownership and restores forced row security. The
  workflow FK validation temporarily releases FORCE under the migration's table
  lock, then restores it in the same transaction.
- Real browser/API/worker: saved cases created through the editor, one passing
  and one failing comparison among 50 real serial worker runs, selected-step reports with frozen names, test-history
  output access even for cases older than the 20-item standalone history, advisory failed/outdated publish warning, no ordinary run-list
  entries and no test-triggered notices. The existing standalone draft/pin and
  real publication journeys also pass. Desktop 1280 and phone 375 inspected.
- Mocked browser: 202 existing journeys and two suite-specific desktop/phone
  effects/report journeys pass. Reduced motion and horizontal containment checked.
- React Doctor: no new diagnostics; full-scope results exactly match current
  main (82/100, the same 13 existing diagnostics). Changed-scope score is 91/100
  with zero diagnostics. No rule suppression or configuration changes.

## Input-case dialog follow-up (2026-10-17)

Keep focused content mounted through
the popup's exit transition. Removing it immediately on close scheduled Base UI
focus repair after Run opened, dismissing that newer menu. Qualification covers
the same menu element across three full-editor cache refetches, an overlapping
dialog close in Chromium (red before the fix), and repeated owned live
input-cases journeys. Polling and editor scope keys retain their existing rules.

The 2026-10-18 collaboration qualification exposed a second close race: the
hub's explicit fallback focus callback bypassed Base UI's normal respect for
focus that had already moved outside the closing dialog. Input cases now returns
focus to its opener only while it still owns focus (or focus is on the document
body). Pointer and keyboard regressions keep the same menu item through actual
popup unmount, repeat the close/open handoff, and check ordinary opener focus.
The original real input-cases journey remains unchanged; no polling or timeout
workaround is involved.

## Later work

Binary/file-backed pinned samples remain later. Keep the current single-step preview seam; never label a published real
run as an isolated test. No automatic production-data capture or
automatic redaction claim.

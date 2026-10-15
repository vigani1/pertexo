# F09 — Workflow failure paths and recovery from a failed step

Status: approved for implementation on 2026-10-13; slice 0 merged in PR #273.
Dispatcher latency correction merged in PR #274. Slice 2 runtime/API merged in PR #275; slice 3 recovery UI merged green in PR #276. Slice 4 failure-route runtime merged green in PR #277. Slice 5 authoring and
handled history are implemented and locally qualified. Merge status and required
CI evidence are recorded on each slice PR. The
owner authorized the revised scope and decisions, including explicit manual
effects acknowledgement, Condition/leaf Stop run and recovery-first delivery.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md). Baseline
inspected: `b0b392889ce0c849f203c7655a1256020267d006` on main.

## Outcome and recommended first-release scope

People can distinguish automatic retries from deliberate new executions, route a
definite failure to an alternative branch, and recover an eligible failed run
without repeating its completed prefix. History tells them what failed, what was
handled and what was reused.

Example: Receive request → Validate → Fetch record → Send notification. Fetch
record has a failure link to Record failure → Send alternative notice. Success
selects the ordinary successor. A definite failure after automatic retries
selects only the failure branch. If that branch succeeds, the run can finish
successfully while Fetch record remains visibly failed and handled. This does
not claim that the original business operation succeeded.

Recovery is the first delivered half. A supported workflow may have Conditions
that choose a path ending in Stop run. If Fetch record on the selected path ends
in a definite failure, recovery creates a new run of the exact source
version/input, reuses completed steps and earlier recorded branch choices, and
executes the failed step onward. Repeating a possibly dispatched definite
failure requires explicit effects acknowledgement. Verified unknown targets require a separate stronger acknowledgement. Unknown
outcomes elsewhere cannot use this command. Earlier steps are shown as reused, never newly executed.

**The first release stays bounded but includes ordinary branching.** Support one
acyclic root decision tree: sequential segments, Conditions with at most one
successor per true/false port, nested nonconverging choices, and Stop run as a
leaf. No ordinary fan-out, shared descendants or joins. Failure handlers stay
disjoint sequential chains, optionally ending in Stop run, attached to eligible
ordinary actions on the selected path. Recovery initially excludes failure
links. Switch, Parallel, Merge, For Each, Wait and Call workflow remain outside
these new paths; their existing execution and full replay stay available.

The owner approved this explicit first-release boundary; do not conceal it. Both
server and editor explain it. The broader F09 ambition for loop/join/child
handling and recovery stays deferred; delivering this bounded release must not
mark that wider scope complete.

Condition already persists exact branch selections and skipped paths. Reusing
those verified facts avoids re-evaluating completed decisions. Stop run has no
output ports and returns terminal success; supporting it as a leaf requires no
new stopping semantics.

The reason to defer the other controls is visible in current code: For Each
requires a unique body sink and prunes finished iterations; joins settle branch
ledgers with paired Parallel identities; a Call executor's success declares a
child rather than completing the logical step. Failure continuation there needs
explicit result and scope rules. Do not infer them from a terminal status or
reuse ordinary Merge as an unplanned fallback join.

## Existing foundation and current ownership

These are inspected owners, not fresh runtime qualification evidence.

| Concern                        | Current source                                                                                                             | F09 implication                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Graph, links and mapping       | `packages/workflow-model/src/graph/contract.ts`, `graph/validation/`, `mapping.ts`                                         | Shared browser-safe contracts; no web-only graph types                                                                     |
| Immutable executable and ports | `packages/workflow-engine/src/compilation/graph-rules.ts`, `compilation/foundation.ts`                                     | Today ports must exist in the catalog; failure ports need explicit shared validation                                       |
| Retry                          | `workflow-engine/src/attempt/retries.ts`, `observation/coordinator-failures.ts`                                            | Keep the one engine policy: currently three attempts, bounded deterministic jitter; route only after its final decision    |
| Readiness and completion       | `workflow-engine/src/transition/scheduling/readiness.ts`, `transition/decisions.ts`, `transition/plan.ts`                  | Today predecessors must succeed/skip, and any failure fails the run; handled failure needs a separate explicit disposition |
| Checkpoint and pruning         | `workflow-engine/src/types.ts`, `checkpoint/`, `transition/prune.ts`                                                       | Keep 256 KiB cap, compact references and no unbounded history                                                              |
| Advancement                    | `packages/execution/src/runs/advance-run.ts`, `database/src/runs/advance/`                                                 | Engine decides; store atomically commits state, checkpoint, events and outbox                                              |
| Attempt input                  | `execution/src/attempts/load-inputs.ts`, `database/src/attempts/inputs.ts`, `workflow-engine/src/attempt/input.ts`         | Current upstream reads require matching successful node/attempt values; reuse needs explicit provenance                    |
| Replay                         | `apps/api/src/workflow-runs/use-cases.ts`, `database/src/runs/commands/replay.ts`                                          | New identity, explicit version/input, `run:replay`, source-scoped idempotency; preserve full replay                        |
| Acceptance                     | `database/src/runs/commands/acceptance.ts`, `records.ts`, `execution/src/runs/initial-checkpoint.ts`                       | Reuse capacity, lifecycle, audit and queue admission                                                                       |
| Failure evidence               | `workflow-model/src/attempt-failure.ts`, `database/src/runs/advance/load/pending-failures.ts`, `apps/worker/src/attempts/` | Kind, safe code and possible-dispatch evidence exist; do not store provider error strings                                  |
| Public reads/events            | `packages/contracts/src/schemas/execution/runs.ts`, `openapi/execution/runs.ts`                                            | Extend existing contracts/OpenAPI, not parallel recovery DTOs                                                              |
| UI                             | `apps/web/src/features/workflow-editor/`, `features/workflow-runs/`                                                        | Editor owns authoring; run feature owns recovery and history                                                               |
| Retention/purge                | `database/src/lifecycle/retention-rules.ts`, `run-artifact-retention.ts`, `workspace-purge.ts`                             | Node/attempt details expire 30 days after completion; run-input expiry is separate                                         |
| Final failure notices/pause    | `database/src/runs/advance/persist/failure-notification.ts`, `database/src/triggers/pause/`                                | Follow final run outcome, not individual routed failures                                                                   |

Authority: [ADR 007](../adr/007-run-node-state-retry-idempotency.md),
[ADR 031](../adr/031-authenticated-user-run-replay.md),
[ADR 019](../adr/019-bounded-parallel-and-merge.md),
[ADR 020](../adr/020-bounded-for-each.md),
[ADR 050](../adr/050-run-data-reads.md),
[ADR 052](../adr/052-record-step-inputs.md),
[ADR 070](../adr/070-workflow-call-boundaries.md) and
[ADR 069](../adr/069-architecture-reset.md).

Recorded step input is best-effort diagnostic data. It can be absent, is cleared
for a retry and is not recorded for connection-backed steps. It cannot become
recovery's input authority. Resolve mappings through the ordinary engine from
copied run input and upstream values. Historical role/migration references in
ADRs do not reinstate retired roles or format versions: ADR 069 governs.

## Proposed terms and decisions

Accepted recovery terms are recorded in `CONTEXT.md`; add routing terms with its
planned ADR. Keep that file a glossary, not an implementation specification.

| Term            | Meaning                                                               | Distinct from                                       |
| --------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| Automatic retry | Another attempt of the same invocation under engine policy            | Queue redelivery or a new run                       |
| Failure link    | An explicit link selected after an eligible definite failure          | Credentials or external alerts                      |
| Handled failure | A failed invocation whose alternative branch succeeded                | A successful attempt or guaranteed business success |
| Recovery run    | New source-linked run reusing a completed prefix                      | Repairing/resuming the original run                 |
| Reused step     | Value copied without executing that step in the new run               | Fabricated attempt or executor cache                |
| Full replay     | Existing new execution from the beginning with explicit version/input | Recovery from a step                                |

The owner accepted the revised recommendations on 2026-10-13. Record the two
planned ADRs using the next free numbers: failure routing/completion, and
recovery eligibility/value provenance/retention. Both are planned here because
persisted meaning is costly to change. Do not reserve numbers or create extra
ADRs for routine placement.

| Decision               | Recommendation                                                                                        | Reason / rejected alternative                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Initial scope          | Root decision trees with Condition and leaf Stop run; handlers sequential; recovery excludes handlers | Preserve frozen earlier choices; defer convergence/concurrency/child reuse |
| Failure link           | Existing edge shape, reserved source port `__failure`; link presence opts in                          | No duplicated target in config or separate error-route graph               |
| Handler ownership      | One failure link per source, each handler chain has one source                                        | No ambiguous fan-out, shared invocation or ordering                        |
| Successful handler     | Run can succeed with handled-failure metadata; source stays failed                                    | No new run status and no falsified successful source                       |
| Return to main path    | None initially; ordinary and failure suffixes cannot converge                                         | Generic fallback/resume and Merge reuse need separate semantics            |
| Retry controls         | Existing policy stays                                                                                 | Adjustable attempts/backoff would broaden this feature                     |
| Recovery input/version | Exact source version and original input; newer publication irrelevant                                 | Changed input/version can invalidate reused computation                    |
| Target safety          | Definite failure needs effects acknowledgement when dispatched; unknown target needs separate stronger acknowledgement              | Automatic retries unchanged; record deliberate new-run risk                |
| Copied values          | Inline JSON, bounded aggregate, owned by new node rows                                                | No aliases into expiring history, artifact pinning or synthetic attempts   |
| Refused recovery       | Explain and offer separately confirmed full replay                                                    | Never silently execute the entire workflow instead                         |

Use distinct copy: “Retry scheduled”, “Retry from this step”, “Replay entire
run”. Retrying an uncertain HTTP acceptance uses the same request identity.

## Failure-route contract

### Graph representation and validation

A failure link is an ordinary `WorkflowEdge` whose source port is `__failure`
and whose target port exists on the handler action. Existing edges are
unchanged. The port is engine-owned, not a provider output. Define its constant
and browser-safe eligibility/shape rule once in workflow-model. Reject
conflicting catalog ports. The compiler calls the shared rule rather than adding
the port to every manifest or introducing a registry subsystem.

For graphs opting in, validate before publication:

1. After separating handler chains, root graph is an acyclic decision tree
   beginning at a valid trigger or standalone callable root. Non-root nodes have
   one incoming link; ordinary actions one successor; Condition at most one
   successor per true/false port. Branches can nest, not converge or fan out.
   Graphs without failure links retain ordinary publication rules; recovery
   independently requires this narrower shape.
2. Failure sources are ordinary actions, not trigger, Condition or Stop run.
   Handlers contain ordinary actions and may end at Stop run. Stop run is a leaf
   with no failure link. Other excluded controls cannot occur in routed graphs;
   reject links inside loop bodies explicitly.
3. One source has zero or one failure link. Handler entry has only that incoming
   link; its ordinary descendants form one disjoint finite chain. No normal-path
   convergence, shared ownership, nested handler or return to source.
4. Handler steps cannot be disabled with a failure link present; an entirely
   skipped branch must not count as handling. Disabled ordinary sources use
   current skip behavior and never route failures.
5. All links/nodes count toward existing graph, executable and invocation
   limits. This feature does not include the F08 limit increase.

Compile route ownership, sink and reachability once per verified executable
projection. Authoring/compilation share one TypeScript rule. UI guidance is not
a second authority. Preserve immutable old publication graphs and checksums.

### Safe failure data

Add one `ValueSource` alternative, `node_failure`, with `nodeId` and `path`,
parallel to `node_output`. Its allowlisted envelope contains only `nodeId`,
`invocationKey`, `attemptNumber`, `errorKind` and `safeErrorCode`.

Only the selected handler entry can map its source's failure. Later handler
steps receive fields through ordinary outputs. Normal-path nodes cannot read
failure data; the handler cannot read a nonexistent successful output of the
failed source. Run input and successful direct predecessors retain current
mapping rules. Do not widen arbitrary ancestor-output access. JSONata consumes
failure fields mapped into input; no new global failure namespace.

Extend the existing attempt input projection with an optional exact source
failure value. Bind it to the source invocation, selected handler entry and
current handler lease in the same workspace/run. Failure links do not request a
successful upstream output from that source; normal links still do. Feed this
value separately into the shared mapping resolver. Never pass the envelope as
the source's `node_output` or relax successful-output verification for all
attempts. Retries of the handler read the same immutable selected envelope.

Persist the envelope only at route selection, as bounded ordinary inline JSON in
a nullable source-node `failure_ref`, retired with node details. It is mandatory
execution data, unlike diagnostic input recording. No stack, provider
message/body/header, URL query, connection secret, input or output is copied.
Safe-code syntax alone does not prove redaction: eligible producers must emit
approved constant/allowlisted codes before they reach this envelope.

### Runtime sequence and terminal meaning

1. Attempt writer records existing outcome/dispatch evidence.
2. Coordinator applies current retry policy. Backoff selects neither path.
   Success selects normal successor and skips handler. Only final eligible
   definite `failed` can select the failure link.
3. Pure engine emits route selection, skips the unexecuted normal suffix and
   admits handler through ordinary node/attempt admission. Source stays failed
   with separate pending handling disposition. Handler identity is deterministic
   in the same run/version; no extra run or child execution.
4. Pending handling prevents premature failure/success settlement. Successful
   handler-sink completion records handled disposition. Failed handler fails the
   run and cannot select another handler. Partial handling is never success.
5. Success requires selected work settled and all eligible failures handled.
   Callable result validation remains authoritative and may fail the run; no
   fallback callable result is invented.

Keep terminal precedence: unknown effects, requested cancellation, run deadline,
unhandled failure, then successful completion. Cancellation/deadline never
select a new handler. Admitted handler work follows existing stop/reconciliation
rules. Attempt timeouts route only when the retry resolver ultimately classifies
them as definite `failed`. Persisted `timed_out`, `canceled`, `outcome_unknown`,
invalid state, corrupted projection and platform bounds/resource failures cannot
route. Not every internal safe code is a business failure: define one allowlist
of eligible classifications before enabling this contract.

No selected eligible route means current failure behavior. Failure routing is
not finally/cleanup for cancellation, rollback or repetition of the original
operation. Unknown outcomes keep their attention card and full-replay warning.

### Persistence, history and notices

Extend invocation/checkpoint state with compact selected-handler-sink identity
and pending/handled disposition. Keep payload outside checkpoint; no second
graph/history array. Mirror handling identity/disposition in narrow nullable
source-node columns for reads. Engine plan owns the rule. Bind identity to the
same run/workspace; no cross-run handler relation.

Commit route selection, envelope, disposition, checkpoint CAS, node transitions,
sequenced `node.failure_routed` / `node.failure_handled` events and outbox
admission together. A duplicate delivery/restarted coordinator observes the same
selected handler, never a second logical handler. Events contain safe
identities/codes, not failure payload or provider text.

Detail shows handling pending/handled beside the still-failed source and the
handler's own attempts. Persist a compact `handledFailureCount` on run summary
in the same transition, so detail retirement does not turn handled success into
an unexplained plain success. Lists do not run one count query per row.

Alerts, inbox failure notices, auto-pause streaks and status statistics continue
to use final run outcome. Handled success emits no final failure alert; failed
handler emits one final failure, not one per attempt. Connection-health evidence
continues independently: handling authentication failure does not make an
expired connection healthy. Verify all these producers against current code.

## Recovery-from-step contract

### Eligibility

Preview and acceptance use one pure recovery planner. Preview is informative,
not a reservation. Acceptance reloads source facts under locks and checks again.

| Required fact                                                                                          | Refusal if missing                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Existing `run:replay` authority, active workspace/workflow and tenant-matching source/version          | Existing authorization/not-found/lifecycle behavior          |
| Terminal failed or outcome_unknown source with exactly one matching target on its selected root path                    | `source_not_failed`, `multiple_failures`                     |
| Source's exact verified immutable executable                                                           | `version_unavailable`; a newer live version is not a refusal |
| Supported decision tree with Condition/leaf Stop run, no handlers or excluded controls                 | `unsupported_graph`                                          |
| Complete successful selected prefix; other paths provably skipped; no unknown effect outside the target          | `prefix_incomplete`, `unknown_effect`                        |
| Complete target evidence; corresponding possible-effects or unknown-outcome acknowledgement when needed          | `effects_acknowledgement_required`, `evidence_unavailable`   |
| No successful invocation or possible effect after target                                               | `suffix_already_executed`                                    |
| Original input and every prefix value needed by ordinary input loading retained as inline JSON         | `values_expired`, `values_missing`, `artifact_value`         |
| No artifact references nested inside those inline values                                               | `artifact_value`; JSON wrapping must not bypass the rule     |
| Canonical input plus copied outputs within aggregate 1 MiB and existing individual/depth/member limits | `reuse_bounds`                                               |
| Seeded checkpoint within current 256 KiB/invocation limits                                             | `reuse_bounds`                                               |

The aggregate 1 MiB budget is a proposed internal safety bound, not a user
setting or a process-RSS promise. Measure parser copies/query buffers. Refuse
before materializing the entire candidate if it exceeds bounds. Neither preview
nor command downloads artifact bytes. Recognize artifact descriptors through the
existing artifact-reference contract; do not reject arbitrary JSON solely
because it contains an unrelated string field named `artifactId`.

Successfully executed prefix provider steps can supply retained allowed outputs:
they will not run again. Show their age. Missing diagnostic input is irrelevant.
The target/suffix resolve current credentials through ordinary authorization;
credentials are never copied. The new target does not inherit the source
provider key. An idempotent-with-key target can therefore create another effect
in a new run.

### Explicit manual effects acknowledgement

Separate automatic execution safety from a person's deliberate recovery:

- A safe target or affirmative no-dispatch evidence across all target attempts
  needs the ordinary recovery confirmation only.
- A definite failed target with possible prior dispatch is eligible with
  `effectRisk: 'possible_effects'`. Require an explicit unchecked
  acknowledgement: “This step reached the service and may have partly taken
  effect. Retrying it can repeat that effect.” Confirm with “Retry anyway”. This
  is a new run chosen by the person, never an automatic retry-policy change.
- A verified unknown target is eligible with `effectRisk: 'unknown_outcome'`.
  Require separate unchecked acknowledgement: “We don't know whether this step
  reached the service. Retrying can repeat its effect.” Confirm with “Retry
  anyway”. Unknown outcomes outside the target and missing/corrupt evidence
  remain refused; full replay keeps its separate warning.

Preview reports one `effectRisk`: `ordinary`, `possible_effects` or
`unknown_outcome`. The last requires literal-true `acknowledgeUnknownOutcome`,
which the possible-effects acknowledgement cannot substitute for.
The command accepts optional literal-true `acknowledgePossibleEffects`,
mandatory when the planner reports possible effects. Bind it into request
hashing and record actor, target, risk and acknowledgement in existing audit and
compact recovery summary. Missing/false/client eligibility cannot bypass the
server. The checkbox starts unchecked for each intent; a lost-response retry
preserves its exact acknowledged request.

Generic HTTP Request remains pinned unsafe, including GET. The current adapter
classification, not method/status alone, is authoritative:

| HTTP result                                             | Current classification              | Recovery                                        |
| ------------------------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| 401/403 or other ordinary definite non-success response | Definite failed                     | Explicit effects acknowledgement after dispatch |
| 429 or 408/425 on unsafe HTTP                           | Definite failed; no automatic retry | Explicit effects acknowledgement after dispatch |
| Unsafe HTTP 5xx                                         | `outcome_unknown`                   | Separate unknown-outcome acknowledgement                            |
| Ambiguous post-dispatch network/timeout                 | `outcome_unknown`                   | Separate unknown-outcome acknowledgement                            |
| Definite pre-dispatch refusal/failure                   | Failed with no dispatch             | Ordinary recovery confirmation                  |

An error response does not prove absence of effects: a service can write then
return 500. Do not relabel unknown results to broaden F09. Provider
reconciliation, cross-run provider-key reuse and unsafe-HTTP classification
changes remain separate decisions. Source:
`packages/integrations/src/http/outcome-policy.ts`.

Full replay retains its own authority/eligibility and effects warning. Refused
recovery offers that separate action. Changed input/version means full replay;
never a silent fallback. No recovery of canceled/timed-out/succeeded runs.

### Condition and terminal Stop run

Use existing branch selections, scoped invocation keys and explicit skipped
facts. Conditions completed before the failed target are reused with retained
`{ selectedPort }` output. Verify it agrees with its saved selection, pinned
port and exact scope. Never re-run those Conditions or infer a choice from
missing rows; absent/conflicting evidence refuses as
`branch_evidence_unavailable`.

Find the successful prefix along the one selected root-to-target path. Other
branches are skipped, not reused successes and not missing prefix values. Seed
prefix nodes, scopes and choices atomically. Reconstruct off-path skips through
the ordinary scheduler using verified graph/frozen choices; missing source skip
rows can be reconstructed only through that deterministic proof. They have no
copied values/attempts. Conditions after the target execute freshly and may pick
a different suffix; never copy skips for decisions that were not completed. A
failed Condition can itself be retried as a safe target under all other rules.

For routing, a source on a selected Condition branch lends that exact scope to
its disjoint handler. Existing reachability skips handlers on unselected paths.
Routing skips only the failed source's normal suffix/inactive handlers; it never
admits an unselected sibling or revises an earlier choice. Condition cannot
source a failure link initially, and handler chains do not contain Conditions.

Stop run (`core.terminate`) is allowed at a main-path or handler leaf. It has no
outputs and returns terminal success. It is not deliberate business failure,
provider compensation or a new global branch-cancellation mechanism. Recovery
before it executes it normally; a failed Stop run can be a safe target. An
already successful one still makes the source ineligible for recovery.

Including Condition needs topology validation plus seeded choice/provenance
support, not another branch engine or stored selection format. Prove true/false,
nested choices, failure before/after/at Condition, restart/redelivery and no
off-path provider effects. Use the existing webhook template with Condition and
leaf Stop run as a representative fixture. If source reconciliation exposes a
missing invariant, resolve it before coding; do not silently drop this support.

### HTTP and request identity

Within the existing workflow-runs module add:

- `GET /v1/workspaces/:workspaceId/runs/:runId/recovery`, under `run:replay`:
  discriminated eligible/refused result. Eligible fields: exact version ID,
  failed node-run ID, reused count, safe display labels and source completion
  time. Refusal: bounded reason codes. No run input/outputs, token or
  reservation.
- `POST /v1/workspaces/:workspaceId/runs/:runId/recover`: session, CSRF,
  `Idempotency-Key`, strict `{ workflowVersionId, nodeRunId }`, optional normal
  validated `deadlineAt` and optional literal-true `acknowledgePossibleEffects` / `acknowledgeUnknownOutcome`.
  No replacement input, client values/eligibility or supplied checkpoint.

Return 202 with ordinary accepted-run/deduplication response. Acceptance refusal
is 409 `run.recovery_unavailable` with safe reasons; malformed input is 400;
identity/access preserve existing disclosure. Preview refusal is ordinary data.
Use existing authenticated-command rate policy; no new rate service.

Hash actor, workspace, source, version, target, deadline, effects
acknowledgement and operation. Use a distinct source-scoped recovery identity,
separate from full replay. Same key and request return the same accepted run;
conflicting material rejects. Check completed deduplication before source-value
eligibility, so exact retries after retention still return known acceptance
under current authorization/result visibility. Do not turn a lost response into
another execution.

### Fresh checkpoint, copied values and truthful provenance

New run uses existing replay trigger and `replay_source_run_id`. Add safe target
identity/reused-count summary fields; full replay leaves them null. No new
trigger kind, run status or family graph. Source history remains unchanged.

Engine builds a fresh checkpoint with completed selected-path prefix, verified
earlier choices, proven off-path skips and failed target ready to execute. Do
not copy revision/cursor, ready set, leases, due times, attempts, dispatch
bindings or provider keys. Target starts attempt 1; its retries use new-run
identity. Deadline is newly validated at acceptance, not copied.

Copied prefix rows are new-run node rows with successful value disposition and
explicit source-run/source-node provenance. Current attempt pointer and number
are both null, matching the existing paired-pointer constraint; public absence
may normalize to zero. No fabricated attempt, duration, lease or provider call.
Source timestamps are provenance, never new execution timestamps.

Retain the pinned side-effect class on reused rows. For an `idempotent_with_key`
prefix node, derive a fresh new-run provider identity only to satisfy the
existing node-row key invariant; it is never dispatched. Do not copy the source
key or falsely label the node safe to bypass the constraint. Allocate new
run/node identities before constructing the seed, inside the acceptance
transaction; a rejected command persists none of them.

Add `OutputReference` variant `kind: 'reused'` with the new node-run ID. Read
its value from that node's ordinary inline `output_ref`, not an old attempt.
Update input loading to accept either matching successful ordinary node/attempt
values or an explicitly seeded reused row. A permissive `coalesce` that accepts
any missing attempt is not sufficient. Completion/run-data/historical graph
reads must understand that same provenance. Do not create fake attempts to make
today's joins pass.

Emit `node.reused` per copied node and normal queued run/audit/outbox
acceptance. No `node.started` for reused steps. Recovery consumes ordinary
run/queue capacity and counts as one new run, with no executed attempts for its
prefix. New suffix effects have fresh provider keys; no cross-run exactly-once
claim.

### Transaction and retention

One workspace transaction, existing app role, forced RLS. Reuse replay's narrow
source/version/lifecycle lock seam. Lock required source node/attempt rows too:
a parent run lock does not protect child rows from detail retention. Use stable
row order and verify against retention, archive and workspace purge.

Read bounded metadata first; select only required candidate inline values in
batches, with row locks and size checks. Reuse canonical JSON, not a new hashing
helper. Avoid fetching provider payloads merely to show availability. Preview
uses a consistent read snapshot and acceptance can still refuse after expiry.

Use database-side size metadata as an early resource guard: the total serialized
values fetched must fit a proposed 4 MiB transport budget, before fetching them
into Node. Then enforce the 1 MiB canonical aggregate after bounded parsing.
PostgreSQL numeric expansion can make storage representation larger than
canonical JSON, so these are separate resource limits. The transport guard can
conservatively refuse a candidate; it must never accept an oversized canonical
value. Record both bounds in tests and the unavailable reason.

Cheap status/topology refusals precede value loading. An otherwise eligible
preview must load its bounded required values to check canonical size and nested
artifact descriptors; do not claim a metadata-only preview can prove that. This
read occurs only for the selected run's recovery action/detail, never for each
history row, and its response never returns the values themselves.

In that transaction: resolve deduplication, load facts, invoke execution/engine
planner, enforce ordinary admission, create copied values and fresh
run/checkpoint, commit audit/lineage/events/outbox. Any failure rolls everything
back, including capacity. No network call, background copier or partial copy
while locks are held. Check query plans, bounds and lock order; do not hide
deadlocks with unlimited retry. The planner owns business eligibility; SQL owns
identity/atomicity.

Copies follow the new run's existing detail window. Explicit recovery can extend
availability of that snapshot; document/show that consequence. It does not pin
the source detail rows. Existing replay lineage retention remains authoritative.
Source-node provenance can become expired history; do not add a foreign key that
retains old node rows indefinitely. New copied-value expiry needs no reference
chase. Workspace purge removes all copies normally.

Artifact reuse, converging/concurrent branches, pruned loops, child Calls,
handlers and changed-version reuse need later reviewed rules. Condition decision
trees are included as specified above.

## Intended structure and interfaces

Existing owners below are authoritative; proposed files are created only when
their slice needs them. No speculative directories or parallel package.

| Owner                   | Existing/proposed placement                                                                                                                         | Responsibility                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| workflow-model          | Existing `graph/`, `mapping.ts`; proposed `failure-routing/contract.ts`, `validation.ts`                                                            | Port/envelope, graph eligibility/ownership, failure mapping contract                         |
| workflow-engine         | Existing `compilation/`, `observation/`, `transition/`, `checkpoint/`; proposed `transition/failure-routing.ts`, `recovery/plan.ts`                 | One pure route/completion/reuse policy and seeded checkpoint; no SQL or network              |
| execution               | Existing `runs/advance-run.ts`, `attempts/load-inputs.ts`; proposed `runs/prepare-recovery.ts`                                                      | Verify persisted projection; feed typed stored facts into engine via injected stores         |
| database                | Existing `schema/runs/execution.ts`, `runs/advance/persist/`, `attempts/inputs.ts`; proposed `runs/commands/recover.ts`, `runs/queries/recovery.ts` | Reads/locks, columns/constraints, copied values and atomic admission; no engine rules in SQL |
| contracts               | Existing `schemas/execution/`, `openapi/execution/`; proposed `schemas/execution/recovery.ts` if useful                                             | Strict HTTP/problems, summary/events and generated OpenAPI using model definitions           |
| API                     | Existing `workflow-runs/` module/guards/ports; focused `recovery.ts` and controller if needed                                                       | Parse, authorize, bind planner, map responses; no maintenance authority                      |
| worker                  | Existing run/attempt compositions                                                                                                                   | Pass facts through existing advancement/input loaders; no recovery consumer/scanner/queue    |
| web editor              | `features/workflow-editor/model/graph/`, `components/inspector/`, `components/canvas/`                                                              | Link commands, safe mapping, inspector composition and thread presentation                   |
| web runs                | `features/workflow-runs/data/`, `model/`, `components/run-actions/`, `components/run-detail/`                                                       | Query/mutation/confirmation, handled/reused history and lineage                              |
| lifecycle/observability | Existing retention/purge/metrics owners                                                                                                             | Normal copy expiry, safe summaries and bounded existing metrics                              |

Database store callback invokes injected execution planner within the
transaction; engine makes the decision, database persists it. Preview and
command share that planner, not duplicated SQL eligibility predicates.
Projection queries may identify candidates, but do not independently decide
safety.

Expose only required additions through existing package doors, notably database
`/runs` and `/attempts`. No `/recovery` barrel, generic `RecoveryManager`,
plugin framework, catch-all helpers, new role or service. Keep folders around
ten files; regroup only touched owners that need it, with moves in separate
commits.

## Frontend journeys and rendering

Keep Weft Status glyphs, threads, inspector and lens/dialog pieces. Plain forms,
semantic text and accessible controls; no new design system.

### Editor

Focused “On failure” composition: default “Stop run”; “Follow failure link”
adds/selects one eligible handler entry through ordinary graph commands. Link is
the sole persisted authority: no mirrored failure policy/target. Removing it
returns to stop behavior, with a consequence warning and existing undo.

Show labeled Failure handle only on eligible actions. Existing failure tone plus
a distinct thread pattern, not color alone. Provide keyboard/menu linking
without dragging. Mapping picker offers only the five safe fields to handler
entry. Invalid target/mapping counts in issues chip and blocks publication with
the shared validation reason. Unsupported graph shape is explained plainly.

Serialized saves, ETags, conflicts, dirty draft, reload, undo/redo, duplication,
import/export and immutable checksums preserve new link/mapping data. A single
node preview does not simulate routed production evidence; failure-dependent
mapping needs actual run evidence. No pinned-error subsystem or test hook.

### Run detail

Keep failed source's fray/×, with “Handling failure…” or “Failure handled”.
Successful handled run reads “Finished — 1 failure handled”, linked to detail.
Handler has its own ordinary attempt story. Missing/retired evidence never
implies handling succeeded.

Query eligibility only when run detail/action is relevant, under existing
user/workspace/run cache scope. No recovery query on every history row, timer,
or Zustand mirror. Preview response owns availability; a command-time refusal
refreshes it.

“Retry from this step” opens confirmation with source version, target, prefix
count/time: “Earlier steps use their saved results. This step and later steps
run again with current connections.” For possible effects add an unchecked
explicit acknowledgement and “Retry anyway”; never preselect the checkbox or
hide this warning under advanced options. No editable JSON. Full replay stays
separate; explain unsupported/expired recovery beside its control.

One stable request key per intent, duplicate-submit prevention and exact request
retained on uncertain HTTP result. “Retry same request” retries acceptance, not
execution. Navigate only on known acceptance, with one feedback owner. No effect
starts a run because query state changed.

New history labels reused prefix, authorized source link and copied outputs; no
fake attempt/duration. Expired source link does not remove copied values. Keep
`model/timeline/step-replay.ts` as event-story reconstruction, not the recovery
command owner.

Use selective editor subscriptions, pure feature-owned models, Base UI controls
and explicit props/children. Preserve lazy route chunks; no eager feature
imports for a shared toolbar. Test reduced motion, focus/keyboard, 375 px width
and 768 px height; actions/explanations reachable without hover or canvas drag.

## Optimization constraints to measure

These are targets, not a claim that the feature is already optimized.

- Ordinary graphs pay no failure-payload read. Route indexes live with a
  verified executable projection, not a global cache of every publication.
- Route selection adds compact data to the existing commit; no extra poller,
  provider call, scheduler or separate transaction per field.
- Decision-tree/handler-chain planning is linear in nodes/links. Reuse indexes
  instead of rescanning every node's entire graph/history on every advance.
- Recovery fetches metadata and required values in bounded batches and seeds
  prefix rows in batches; no N+1 SQL or cross-run output dereference.
- Preserve 200-node / 4,000-edge / 1 MiB graph, 256 KiB checkpoint and 256 KiB
  individual inline-value caps; proposed copied aggregate cap is 1 MiB. Maximum
  identifier/metadata fixtures must still fit. Refuse before writes; never raise
  limits as a fix.
- Measure ordinary baseline versus routed checkpoint bytes/rewrite volume,
  acceptance queries/plans/time and process-memory delta at maximum eligible
  size. Record exact environment/fixture and investigate regressions. No
  arbitrary throughput/SLA or 4 GB server guarantee.
- No per-run/workflow/node/error-code metric labels. Safe identifiers belong in
  scoped logs/events; use existing bounded operation/outcome dimensions.

## Delivery order and per-step latency prerequisite

Measure current step-to-step delay before F09 engine/persistence changes. This
is prerequisite evidence, not a diagnosed cause or a new telemetry/CI subsystem.
Keep the baseline in this plan with a repeatable local command.

Use the existing real worker/queue/database fixture and an ordinary Manual run
with 20 small Set actions and leaf Stop run. Measure at least 30 warm runs after
5 discarded warmups; report cold startup separately. Use an isolated workspace,
synthetic bounded JSON, no provider calls or owner data. Record exact SHA,
machine/CPU/disk, Node/Postgres/Redis, worker concurrency, poll settings and
watch/dev versus compiled execution mode. The measurement must exercise actual
outbox/BullMQ/worker transitions, not pure-engine timings alone.

Report median/p95/max predecessor-completion to successor-start gap, executor
time, total run time and coordinator/outbox-to-claim phases where existing
traces/logs expose them. Persisted event timestamps show the visible durable
interval, not exact transaction commit time. Use monotonic clocks for phases
within one process and identify uncertainty when comparing other clocks.
Separate provider time and SSE/browser animation/rendering from advancement.

Current outbox poll default is 250 ms in worker config/dispatcher. Measure
whether it contributes before calling it the cause or lowering it. Run a small
supported Condition/Stop run fixture and modest concurrent load separately, not
averaged into the straight-line baseline. Record checkpoint bytes, query counts
and CPU/RSS on the same setup. Compare future engine slices against this
baseline.

If existing timestamps cannot separate phases, use bounded temporary local
fixture instrumentation and remove it, preserving the raw results and reporting
limits. No production test hook, extra daemon/CI job, hosted observability
service or arbitrary hard timing assertion. A repeatable command with real data
is required before engine changes; the first measurement is recorded below.

If a material delay reproduces, use the diagnosing-bugs feedback loop, establish
cause and make a narrow existing-seam fix in its own PR before F09 engine work.
Do not weaken transactions/outbox/fencing or lower polling blindly. A cause
requiring an unplanned subsystem triggers the owner's existing stop rule.

Owner accepted scope/decisions on 2026-10-13. One coherent PR per implementation
slice, green CI/merge before next. No enabled placeholder UI or permanent
feature-cohort framework. Backend contracts must already settle their behavior.

| Slice                                  | Concrete result                                                                                                 | Main owners                                      | Required evidence                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Plan/decisions and baseline         | Reviewed proposal; recovery ADR first; latency measured before engine work; routing ADR before its slice        | Docs/existing fixtures                           | Baseline command/data and branch/provenance/acknowledgement scope reviewed                                                                                              |
| 1. Existing recovery clarity           | Close demonstrated retry/unknown/full-replay presentation gaps only                                             | Run UI/contracts if needed                       | Wait/retry story, source replay and unknown warning; skip code PR if no real gap                                                                                        |
| 2. Recovery runtime/API                | Preview, atomic new run/copies, preserved prefix choices, effects acknowledgement and ordinary suffix execution | Engine/execution/database/API/worker/contracts   | Prefix never runs; no off-path effects; source unchanged; fresh keys; exact deduplication; retention/capacity/risk tests; baseline comparison                           |
| 3. Recovery product/qualification      | Confirmation, refusal/full replay, Condition/Stop run example, reused history and user docs                     | Run UI/existing integrated suites                | Real definite HTTP failure with explicit acknowledgement; strongly acknowledged unknown target; response loss; desktop/phone screenshots; independently useful recovery                      |
| 4. Failure-route runtime               | Model/mapping/compiler, selected-branch routing/completion and atomic handler execution                         | Model/engine/execution/database/worker/contracts | Backoff before route; one handler after restart; source still failed; off-path handlers skipped; pending prevents settlement; final notices/health; baseline comparison |
| 5. Failure-route product/qualification | Author/save/publish and inspect handled history; complete supported-scope qualification                         | Editor/run UI and existing browser suites        | Browser/API/database/queue/worker journey; Condition scope and leaf Stop run; reload/undo/import/export; keyboard/mobile/reduced motion                                 |

Recovery goes first: it closes a direct user gap without changing canvas shape.
Alerts/inbox already report failures, but cannot handle expected errors or
execute an alternative path; routing remains distinct, delivered after recovery
is independently useful.

Schema changes land in the slice that first needs them. Moves stay separate from
logic. Each PR reports Moved/Removed/Lines, updates tracker and states limits.
Mocked browser tests alone do not complete visible slices.

## Verification matrix

Use existing suites/fixtures, no new CI job, custom proof runner, runtime test
hook or external provisioning.

| Area                 | Required behaviors                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model/compiler       | Ordinary graph unchanged; reserved collision, invalid handler ownership/target/cycle/convergence/disabled/control/nested shape and mapping rejected; portable/duplicate round-trip                               |
| Retry/route engine   | Backoff before route; one selection; source failed; normal suffix skips; pending handler blocks premature completion; failed handler and unknown/cancel/deadline precedence                                      |
| Persistence          | Envelope/selection/disposition/CAS/events/outbox atomic; duplicate/stale facts, CAS rollback, tenant IDs, safe producer allowlist                                                                                |
| Recovery planner     | Exact source version/input; selected prefix and verified Condition choices/skips; complete dispatch evidence; distinct possible-effects/unknown-outcome acknowledgements; unknown outside target refused; artifact/bounds                        |
| Recovery transaction | Concurrent same key one run, conflicts, lost response, exact retry after source expiry, preview race, node retention/archive/membership/purge races, complete rollback/capacity                                  |
| Worker/restart       | Kill before/after commits; ordinary redelivery; one execution per acknowledged recovery intent, no unrequested repeat; prefix has no attempts; suffix leases/fences/retries                                      |
| Controls regression  | Existing loop/join/Call execution, pruning, borrowed slots, cancel and histories unchanged; unsupported route/recovery refused clearly                                                                           |
| Notices/usage        | Handled success no failure notice/pause increment; failed handler one final failure; connection-health observation preserved; recovery one run/new attempts only                                                 |
| Retention            | Source detail expiry after copy, new copy readable until its expiry, expired source label, retained handled count, complete workspace purge                                                                      |
| HTTP/security        | Session/CSRF/roles/RLS/lifecycle/disclosure; strict requests; server-enforced acknowledgement; hash/audit binding; replay capability; preview no payload; exact deduplication                                    |
| Browser              | Definite HTTP failure with unchecked acknowledgement; stronger unknown target acknowledgement; Condition/Stop run/frozen earlier choices; lost response; source/new navigation; handled/reused truth; responsive keyboard/reduced motion |
| Bounds/performance   | Maximum graph/IDs/value caps; bounded query plans/copies; ordinary path no payload cost; no per-row eligibility requests                                                                                         |

Existing test homes: engine compilation/transition/checkpoint tests;
`packages/database/test/runs/run-store/`, `runs/acceptance/`, `lifecycle/`;
`apps/worker/test/runs/consumer/`; `apps/api/test/workflow-runs/` and existing
editor browser fixture; `apps/web/test/features/workflow-runs/`, editor tests,
`apps/web/e2e/run-history.spec.ts` and
`apps/web/e2e-live/editor/run-recovery.spec.ts`.

Every code commit: lint, TypeScript and appropriate units. Before push: normal
hook, build/format/architecture/dependency/generated-contract checks, schema
parity if changed and real persistence/worker cases for runtime work. Visible
changes also run web units, mocked e2e, relevant React Doctor and real browser
journeys with desktop/phone screenshots. Diagnose warnings; do not suppress them
for a score. Inspect existing CI and natural postmerge checks.

The accepted planning slice passed formatting/source checks, full lint,
TypeScript, unit suites, build, architecture and unused-code checks. Its opt-in
real worker measurement passed with a disposable database and Redis namespace.
Feature behavior and browser qualification remain gates of the later slices.

## Migration and rollout

ADR 069: one current format until launch. Extend it with optional fields and
explicit mapping/reference alternatives, not numbered graph/checkpoint formats,
engineVersion or mixed-release readers. Old immutable publications stay intact.
Define schema once in Drizzle and generate additive migrations/policies/grants.
Preserve CAS fence; no failure policy SQL functions/triggers.

Install migration and matching API/worker/catalog/web through existing release
boundary. Old workers cannot consume newly routed/reused state. Once accepted,
older binaries are unsafe rollback: stop admission/writers through existing
controls, fix forward preserving immutable versions, accepted runs and lineage.
No new database switch/cohort system to permit unsafe downgrade.

Failed route commit leaves the original durable attempt fact for ordinary
coordinator retry. Failed recovery transaction creates no partial new run.
Unknown HTTP acceptance is resolved by same request key. Local qualification
does not authorize production deployment.

## Exclusions and later work

- No arbitrary step execution/rewind, original-run repair, automatic recovery,
  cross-workspace reuse or declaring an uncertain provider operation failed.
- No changed-version/input reuse, canceled/timed-out/successful recovery, mixed worker versions, adjustable retry policy or operator recovery
  console.
- No fallback-output/resume node, cross-branch Merge, loop item
  skip/aggregation, child-family clone/retry or new error-workflow trigger. Each
  needs reviewed result/scope rules before implementation.
- No artifact copies/pins, output cache, new retention subsystem, scheduler,
  service, package, role, queue or CI job.
- No provider accounts, real external effects, hosting, image downloads or
  deployment as part of this proposal's qualification.

Two-question test: adding broader support later is not made much harder by
explicit links, provenance and one pure engine policy. Keep those seams; do not
build speculative adapters/formats. Broader scope stays separately tracked.

## Primary references checked 2026-10-13

[n8n node settings](https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes.md)
offer stop, continue and error-output behavior. This supports explicit failure
choices; Pertexo excludes implicit last-valid-data continuation.

[n8n error workflows](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md)
are a separate workflow-level mechanism. Pertexo initially handles within the
current run rather than adding another trigger product.

[n8n failed-execution retry](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md)
offers original/current workflow with previous data. Pertexo recommends original
immutable version only for reuse; changed versions use full replay.

[Make error handlers](https://help.make.com/error-handlers) distinguish retry,
skip, resume with substitutes, commit and rollback. Those are separate
semantics, not behaviors to hide behind one toggle.

Review follow-up also checked
[Zapier's manual errored-step replay](https://help.zapier.com/hc/en-us/articles/8496241726989-Replay-Zap-runs)
and [Make's Retry handler](https://help.make.com/retry-error-handler). They
offer explicit manual recovery distinct from whole-run replay or automatic
behavior. That supports prioritizing user-chosen recovery; it does not prove
matching dispatch classifications or absence of duplicate effects in Pertexo.

Scope/safety/placement above are Pertexo recommendations inferred from its
current code, not competitor guarantees or performance/correctness evidence.

## Planning scenario check

These are design checks, not executed tests. They explain why the recommended
interfaces contain the rules above; implementation still has to prove them.

| Scenario                                                         | Required conclusion                                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ambiguous unsafe post-dispatch timeout                           | Unknown stays blocked from automatic retry/routing; explicit target recovery requires separate stronger acknowledgement |
| Handler waits in retry backoff while its source is failed        | Pending handling keeps run nonterminal; only handler settlement permits final status                                       |
| Source input expires between preview and command                 | Recheck under locks; refuse before admission or copy, with full replay separate                                            |
| Acceptance committed, response lost, source later expires        | Exact request retry returns accepted new run before source eligibility is re-evaluated                                     |
| Retention deletes a source node while recovery accepts           | Lock node/attempt rows, not just parent run; either complete atomic copy or refuse, never partial prefix                   |
| Successful prefix used a provider idempotency key                | New prefix row retains side-effect class and derives its own nondispatched key; no old key or fake attempt                 |
| Output is inline JSON containing an HTTP artifact body           | Reject recognized nested artifact descriptor; do not assume inline means self-contained                                    |
| New live version exists after source failure                     | Recover exact source version; do not read mutable latest to decide or seed                                                 |
| Definite dispatched HTTP failure selected for manual recovery    | Eligible only after explicit effects acknowledgement; new provider identity, unchanged automatic retry safety              |
| Unsafe HTTP 500 response                                         | Current adapter calls it unknown; only separately acknowledged manual target recovery is allowed                                           |
| Completed Condition preceded failed HTTP step                    | Reuse exact saved choice; skip sibling; never re-evaluate earlier decision                                                 |
| Condition is after failed step                                   | Execute it freshly when reached; do not freeze an unexecuted source decision                                               |
| Supported path ends in Stop run                                  | Preserve terminal-success leaf behavior; no invented global-stop meaning                                                   |
| Run is callable but its result maps to the skipped normal suffix | Normal callable result validation fails; handler success cannot invent a missing result                                    |
| Failure link crosses loop/join/Call boundary                     | Reject unsupported scope; Condition trees and leaf Stop run remain supported as specified                                  |

The owner approved the bounded scope and routing/reuse decisions on 2026-10-13.
[ADR 072](../adr/072-failed-step-recovery.md) records recovery; the planned
routing ADR lands before its runtime slice. Performance and concurrency claims
remain evidence gates in the code slices.

## Delivery tracker

- [x] Current code/ADRs reconciled and existing owners inspected.
- [x] Detailed scope/behavior/storage/interfaces/UX/evidence proposal written;
      scenario checks and primary references recorded.
- [x] Owner approved the revised first release and recommended decisions on
      2026-10-13, authorizing implementation in order.
- [x] ADR 072 records accepted recovery decisions; recovery glossary/roadmap
      reconciled.
- [x] ADR 073 and routing glossary record the approved semantics before runtime implementation.
- [x] Slice 1: no demonstrated existing recovery-clarity gap; retain current UI.
      Full web units and four mocked run-history browser cases passed.
- [x] Slice 0: per-step latency measured before F09 engine changes.
- [x] Diagnosed dispatcher polling delay: PR #274 merged; all CI and natural
      postmerge checks passed before recovery runtime.
- [x] Slice 2: PR #275 merged green; recovery runtime/API qualified with choices, acknowledgement,
      races/retention and baseline comparison.
- [x] Slice 3: PR #276 merged green; real HTTP/Condition/Stop run recovery, response loss and reused history qualified.
- [x] Slice 4: PR #277 merged green; failure-route runtime independently verified.
- [x] Slice 5: authoring/handled history and combined qualification complete;
      browser-authored actual HTTP handling and unknown refusal independently verified.
- Merge gate: each scoped PR rebase-merges only after green required CI; inspect
  natural postmerge checks and record their outcome on that PR.
- [ ] Broader loop/join/Call/artifact scope separately planned and approved.

Planning evidence includes source inspection, scenario analysis and the measured
existing execution path below. Broader deferred implementation and qualification remain
unchecked until their slices pass. The broader scope remains separately gated.

## Slice 0 measured execution baseline (2026-10-13)

Base code: `b0b392889ce0c849f203c7655a1256020267d006`; only the fixture and
accepted documentation changed. Apple M4, 10 cores, 24 GiB RAM, macOS ARM64,
local SSD; Docker VM about 7.65 GiB. Node 24.15.0, pnpm 11.22.0, PostgreSQL
18.6, Redis 8.2.8. Compiled worker runtimes share the Vitest process; PostgreSQL
and Redis run in existing local Docker containers. No owner data, external
provider calls, image downloads or service restarts.

Coordinator admission maximum 10; coordinator and attempt database pools each 6,
maintenance/dispatcher pools 2, acceptance pool 4. Attempt heartbeat 1 s, lease
10 s; dispatcher batch 10, lease 30 s, default poll 250 ms. The real outbox
dispatcher publishes to BullMQ; the fixture never manually publishes work.

```sh
pnpm build
WORKER_TRANSPORT_INTEGRATION=true F09_LATENCY_SAMPLE=true \
  F09_LATENCY_REPORT=/tmp/pertexo-f09-latency-baseline.json \
  pnpm --filter @pertexo/worker exec vitest run \
  --config vitest.integration.config.ts \
  test/runs/consumer/latency.integration.test.ts
```

Runtime readiness took 22.55 ms, excluding compilation and fixture provisioning.
One cold 22-step run took 12,085.47 ms. After five discarded warmups, with no
other build/test gates running concurrently:

| Sample                      | Runs / gaps | Gap median / p95 / max (ms)    | Run median / p95 / max (ms)       | Checkpoint bytes |
| --------------------------- | ----------- | ------------------------------ | --------------------------------- | ---------------- |
| Manual + 20 Set + Stop run  | 30 / 630    | 489.58 / 507.77 / 521.74       | 11,902.37 / 11,969.31 / 11,973.68 | 6,281            |
| Condition selected path     | 10 / 20     | 491.50 / 508.23 / 519.74       | 1,819.47 / 1,866.38 / 1,866.38    | 1,667            |
| Five concurrent linear runs | 5 / 105     | 2,586.80 / 2,606.77 / 2,622.77 | 58,445.25 / 58,939.41 / 58,939.41 | 6,281            |

Sequential node started-to-completed median/p95: 41.43/49.36 ms (includes input
loading, execution and persistence; not a pure executor span). Sequential outbox
created-to-published median/p95: 235.53/258.01 ms. Monotonic claimBatch
median/p95: 8.24/11.40 ms; queue publication: 1.63/2.42 ms. Process user/system
CPU during warm samples: 41.19/5.79 s; RSS before/after: 250.84/426.70 MiB.
Vitest/fixtures are included; this is not a deployment RAM requirement.

Completion checks sample every 25 ms; durable gaps use PostgreSQL row
timestamps, not exact commit timestamps. Exact queue claim time, coordinator
query count and separate executor spans are not available here. The opt-in test
writes raw samples to the supplied temporary path; generated runtime data stays
outside Git.

Diagnosis: each advancement needs two sequential outbox publications. The loop
waits 250 ms after every batch, and fair claiming selects one row per workspace
per round. This explains both the approximately 490 ms gap and its increase
under five concurrent runs. A diagnostic 25 ms poll probe reduced median
sequential gap to about 42 ms and concurrent gap to about 275 ms. Its initial
measurement wrapper omitted producer prototype methods, causing cleanup failure
after runs completed; that wrapper is fixed, and both a short probe and the
controlled full 250 ms baseline now pass. Those earlier probe numbers are
diagnostic evidence, not the final fixed-path qualification.

Before slice 2, a separate performance PR will poll quickly after publishing
work and back off to the configured interval while idle. Preserve fair claims,
leases, transactions, automatic retry safety and configured idle load. Prove
poll scheduling with fake timers, rerun this real baseline, and record results;
no new configuration, daemon, production hook or CI job is needed.

## Slice 1 existing recovery clarity (2026-10-13)

No code PR needed. Existing `OutcomeUnknownCard` explicitly tells the person to
check the remote service before replaying because the action may repeat.
`ReplayRunDialog` names the exact version, starts from the source input while it
is retained, explains input expiry and warns that other-service steps run again.
`useRunReplay` preserves the same request and key after an unconfirmed response.
The timeline distinguishes a scheduled automatic retry from its attempts and
shows the backoff countdown.

Full workspace unit gates passed, including run replay and timeline behavior.
All four `e2e/run-history.spec.ts` Chromium mocked-API cases passed, including
exact displayed version/input replay and bounded mobile history. This verifies
the existing journey; it does not qualify the new suffix-recovery feature or
replace its real-stack browser gate.

## Dispatcher latency correction qualification (2026-10-13)

Existing dispatcher loop now uses 25 ms after a successful or possibly completed
publication, capped by the configured interval. Empty rounds double the delay
back to that interval; failed claims/publications restore the full interval.
Initial idle behavior, fair one-row-per-workspace claiming, publication fencing,
retry deadlines and prompt shutdown are preserved. No new setting or service.

Three new fake-timer behavior tests failed on the original loop, then passed
with the scheduling change. Additional cases cover initial idle behavior,
publication failure/unknown acknowledgement and shutdown without leftover
timers. The existing dispatcher suite continues to exercise lease ownership,
late settlement, drain and retry behavior.

Repeat the slice 0 command on base `191f38b196ca41d2ad8eaf62356a61065f523714`
plus the scheduling change, retaining a configured 250 ms interval. Same
machine, compiled runtime, pools, 30 sequential runs after five warmups, ten
Condition runs and five concurrent runs; no other build/test gate running
concurrently. Raw samples: `/tmp/pertexo-f09-latency-adaptive.json`, outside
Git. All runs and owned-runtime cleanup passed.

| Sample                      | Gap median / p95 / max (ms) | Run median / p95 / max (ms)    | Checkpoint bytes |
| --------------------------- | --------------------------- | ------------------------------ | ---------------- |
| Manual + 20 Set + Stop run  | 45.65 / 139.67 / 205.47     | 1,995.22 / 2,728.38 / 2,913.54 | 6,281            |
| Condition selected path     | 46.24 / 96.82 / 148.42      | 297.20 / 422.09 / 422.09       | 1,667            |
| Five concurrent linear runs | 277.06 / 287.07 / 294.87    | 6,605.25 / 6,651.67 / 6,651.67 | 6,281            |

Readiness: 22.25 ms; cold run: 2,757.75 ms. Sequential started-to-completed
median/p95: 19.73/30.53 ms; outbox created-to-published: 25.37/62.53 ms.
Monotonic claimBatch median/p95: 2.29/4.24 ms; queue publication: 0.50/0.94 ms.
There were 2,370 claim calls and 1,915 publications (baseline 1,916/1,915). Warm
measurement process user/system CPU: 16.07/2.16 s; RSS before/after:
398.89/622.70 MiB. RSS includes Vitest, retained samples and GC variation; it is
not a production memory improvement or sizing claim. The fixture's 25 ms
completion reads also make long baseline runs perform more observation queries.

Measured median gap improved about 91%, with unchanged checkpoint size and
unchanged scheduling semantics. Idle polling remains bounded at the original
configured rate; these measurements cover this local workload, not provider
latency or an arbitrary graph throughput guarantee.

### Slice 2 implementation refinements

Exact accepted-command recovery uses the existing retained idempotency record
window (24 hours). It can outlive source value retirement within that window;
it is not an indefinite receipt. The UI must stop offering an uncertain
same-request retry after that window. No new receipt store or TTL is added.

Disabled Condition steps are refused in this first recovery scope because they
have no saved selected-port proof. Ordinary disabled actions remain supported;
existing execution semantics for disabled steps are unchanged.


## Slice 2 runtime qualification (2026-10-13)

The runtime branch implements the shared pure decision-tree/prefix policy,
metadata-first bounded storage reads, exact source-input validation, owned
inline copies, atomic ordinary run admission and the guarded preview/recover
endpoints. The recovery target executes through the existing coordinator and
node-attempt queue. Reused rows have no attempts or execution timestamps; their
source provenance is separate. Step health and execution history exclude those
copies. The source run is unchanged.

The isolated compiled-worker fixture uses the real PostgreSQL roles and forced
row security, Redis, BullMQ and outbox dispatcher. It proves frozen Condition
choices, a callable result selected from a copied prefix, suffix-only execution,
concurrent exact-key acceptance, request conflicts, quota rollback without a
receipt, and exact accepted retries after source details retire. Scripted
registry failures also prove server-enforced acknowledgement for definite
dispatched `http.request` failures, audit/summary risk and unknown-outcome
refusal. These scripts make no external HTTP calls; the real provider/browser
journey remains a slice 3 gate.

Pure tests cover leaf Stop run targets, both Condition ports, unsupported
controls/topology, missing/corrupt evidence, previous reused prefixes, original
input/callable validation, nested artifact references, aggregate bounds, fresh
identities/checkpoints and provider keys. HTTP stack tests exercise current
capabilities, CSRF, strict bodies and safe refusal reasons. The timeline reader
does not manufacture spans or attempts for copies. No recovery control is
exposed in the product until slice 3.

### Ordinary execution comparison

Repeat the existing slice 0 measurement with the configured 250 ms polling
interval and the same compiled fixtures/pools. A temporary clean main checkout
at `bf1a93a05cc529967a9aa65d4a25f967b7fe4187` supplies the fresh control. Both
measurements run alone, with 30 sequential runs after five warmups, ten Condition
runs and five concurrent runs.

| Sample | Sequential run median | Sequential gap median | Condition gap median | Concurrent gap median | Ordinary checkpoint |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh main control | 1,668.630 ms | 42.422 ms | 43.133 ms | 273.384 ms | 6,281 bytes |
| Recovery runtime repeat | 1,734.392 ms | 42.043 ms | 41.038 ms | 273.288 ms | 6,281 bytes |

An initial runtime sample was slower (2,696.559 ms sequential run and 86.235 ms
gap). The fresh paired repeat shows no repeatable regression; it does not erase
that sample or establish a production latency guarantee. Condition checkpoints
stay 1,667 bytes. The fixture's existing shared-process memory and completion
sampling limitations still apply. Local raw reports are retained outside Git at
`/tmp/pertexo-f09-latency-recovery-runtime.json`,
`/tmp/pertexo-f09-latency-main-control.json` and
`/tmp/pertexo-f09-latency-recovery-repeat.json`. The temporary control checkout
was archived after measurement.


## Slice 3 recovery product qualification (2026-10-14)

The failed run's action loads the authoritative preview only when opened. It
explains unsupported or expired results and offers separately confirmed full
replay. Eligible confirmation names the exact version/step, copied prefix count
and original completion time; original input cannot be edited. Definite
possibly dispatched failures require an unchecked effects acknowledgement.

Recovery and full replay share one feature-local retained-command hook. It
fences same-tick duplicates, retains exact reviewed values/key on network,
protocol, timeout or server failure, suppresses late actor/scope results and
stops retries after the existing 24-hour receipt window. Closing confirmation
keeps an uncertain request in memory; leaving/reloading loses it, as the UI
explains. There is no storage, global command manager or per-history-row preview.

History labels copied rows Reused, links source provenance and reads the new
run's owned output without fetching source values or inventing input, attempts
or duration. Source details can expire independently. Empty saved outputs are
named as saved outputs, rather than suggesting new execution.

The existing owned webhook/HTTP browser fixture now authors a root graph with
Validate, Set fields, Condition, HTTP and a leaf Stop run through ordinary
editor controls. Real encrypted connection resolution, API, PostgreSQL with
forced RLS, Redis, BullMQ and worker execution remain in the path. The private
loopback target first returns a definite HTTP 401, then succeeds on recovery.
At 375 × 768 with reduced motion the person acknowledges effects, loses the
actual committed acceptance response, closes/reopens confirmation and retries
the same key/body. Exactly one recovery run succeeds, all four prefix copies
have no attempts/timestamps, the original Condition choice is reused, and only
HTTP/Stop execute freshly. Source node facts remain unchanged.

A separate controlled HTTP 503 after an effect remains outcome_unknown, has no
step-recovery control and is refused by the preview. The actual attempt row is
failed with executor_failure_kind=outcome_unknown; the logical run is unknown.
The test also verifies the original signed-ingress deduplication journey. Exact
request material keeps the same HTTP dispatch binding (a request fingerprint);
the target node/attempt identity is new. It does not claim a new provider
idempotency key for unsafe HTTP, which has none.

The real journey and durable verifier passed locally in the existing owned
integration containers, using disposable UUID databases and Redis namespace 11;
no owner database, credentials, external provider or image download was used.
Controlled mocked browser screenshots cover 1280 × 768 and 375 × 768, keyboard
acknowledgement and reachable actions. Authenticated live screenshots/traces
remain disabled; the review images use synthetic identities and mock data.
Failure routing remains slices 4/5. This qualification does not complete the
broader deferred loop/join/Call/artifact scope.


Local gates: full `pnpm check`, 1,114 web units, 1,965 API units, 720 worker
units, all 146 mocked browser cases and both owned recovery/HTTP browser
journeys passed. React Doctor changed-scope score is 100/100; no rule suppression
or configuration change. Three existing editor tests timed out when all app
suites ran alongside builds; the full web suite passed independently with four
workers. No test timeout or production behavior was changed for those failures.

Review images use synthetic mocked data: [desktop confirmation](../media/recovery-confirmation-desktop.png),
[phone confirmation](../media/recovery-confirmation-phone.png),
[desktop reused history](../media/recovery-reused-desktop.png) and
[phone reused history](../media/recovery-reused-phone.png).
The existing CI browser job now runs both existing live scenarios; no CI job was
added. PR #276 merged after all required CI passed.


PR #276's first CI run exposed an existing JSONata test assertion: total
admission/startup/evaluation/termination took 251.7 ms against an arbitrary
250 ms limit. The evaluator's 100 ms evaluation deadline begins at its started
message, with a separate 5 s startup policy. The test now observes actual worker
exit and capacity reuse; a controlled-clock case checks the exact evaluation
deadline after delayed startup and refuses capacity until termination settles.
No production deadline, test timeout or evaluator behavior changed. The fix
lands as a new commit; all required CI passed on the new commit before merging PR #276.

## Failure routing runtime qualification (2026-10-14)

Slice 4 implements the accepted ADR 073 contract. The shared model rule owns
handler shape, source/entry mapping and unsupported scopes. Verified executable
identities retain derived route ownership, sinks and normal suffixes outside the
stored executable. Ordinary publication checksums and checkpoints stay unchanged.

Final eligible executor classifications select one handler after retry policy;
backoff, unknown outcomes, cancellation, deadlines and platform/internal errors
cannot select it. The source remains failed. The checkpoint stores only its
selected sink and pending/handled disposition; the five-field safe envelope is
mandatory source-row inline data. The handler entry reads that envelope separately
from successful direct-predecessor outputs, under its current workspace/run,
source invocation and attempt lease. Restored checkpoints reject forged sinks,
unselected active handlers and incompletely handled chains.

Migration 0005 adds nullable source evidence/handling columns, the retained run
count and the two route event names. Its narrow app-role column grants preserve
the existing three roles and forced workspace security. Selection, evidence,
physical transitions, checkpoint CAS, events and outbox admission share the
existing coordinator transaction. Final run outcome continues to own notices;
step health retains the original failure. Successful handled sources cannot
explain an unrelated later run-result failure in the run list.

Local evidence (PR #277 merged green; slice 5 authoring remains pending):

- Model 259 and engine 437 unit tests passed, including handler shape/ownership,
  fixed classification codes, separate failure mappings, retry exhaustion,
  cancellation/deadline precedence and restored-state checks.
- Database 528, contracts 228, execution 17, API 1,965, worker 720 and web 1,114
  unit tests passed. All 146 mocked browser tests passed; React Doctor's changed
  scope remains 100 with no suppressions.
- The isolated real PostgreSQL/forced-RLS, Redis/BullMQ, outbox and compiled-worker
  journey passed. It runs a Condition-scoped handler, restarts the coordinator
  while handling is pending, verifies one logical handler/route event, safe
  mapped evidence, skipped normal/off-path steps, truthful failed-step health,
  handler failure and unknown precedence. Handler retry reads the same immutable
  failure value; an unselected restored choice is refused. A callable with a missing source
  result still fails after successful handling. Removing node details retains
  the summary count; successful handling produces no failure-inbox intent.
- Full `pnpm check` passed: formatting, build, lint, types, dependencies,
  generated contracts, schema and module boundaries. The walkthrough exposed
  a missing new-column update grant before any attempt was admitted; the
  migration now grants only the required app-role columns. The fixture's
  bounded wait and resource cleanup preserve failures without leaking its
  isolated database or Redis namespace.

These tests do not establish support for loops, joins, Calls, returning to the
normal path or artifact recovery. The UI authoring and combined real HTTP/browser
qualification belong to slice 5.

A fresh ordinary-path comparison used the same isolated services and current
main (`8106b8e45`). The first routing sample had an 81.410 ms median gap and
2,081.643 ms median run, so it was investigated rather than treated as a
regression or silently omitted. Fresh main measured 46.021 ms / 1,967.842 ms;
the routing repeat measured 43.876 ms / 1,837.918 ms. Condition gaps were
41.556 / 41.633 ms and concurrent gaps 278.280 / 276.130 ms. Checkpoints remain
6,281 bytes for the ordinary graph and 1,667 bytes for Condition. This shows no
repeatable ordinary-path regression under this local fixture, not an SLA.
Raw samples remain outside the repository in
`/tmp/pertexo-f09-latency-routing{,-main,-repeat}.json`; the temporary control
checkout was archived after comparison. The fixture's existing measurement
limitations still apply.


## Slice 5 — failure-path editor and handled history

The editor adds a labeled Failure handle to eligible root actions and an
“On failure” control on Setup. Choose an existing valid handler or add one
through the normal step picker. The failure link is the only persisted policy.
Handlers are separate sequential chains and may end in Stop run; Conditions
remain supported in the ordinary decision tree. Loops, joins, Wait and Call
workflow remain outside this release. Invalid shapes use the shared model's
reason rather than creating a different editor rule.

The handler entry's Insert data picker offers the five safe failure fields or
the whole safe envelope. It never offers the failed source as a successful
output. Single-step preview explains that these mappings need real run evidence.
The canvas uses the existing failure tone, a distinct dashed thread and a
visible Failure label. Existing save/conflict handling, undo/redo and portable
files preserve the link and mapping. Copies remap source IDs when the source
and handler are copied together.

Removing a source, failure link, handler entry or internal handler link asks
before removing its owned chain. This prevents a detached handler from becoming
an ordinary starting path. The existing undo restores the exact chain and
mappings. A changed draft requires reviewing the current removal again.
Removing only a leaf Stop run keeps the remaining valid handler chain.

Successful handled runs read “Finished — N failures handled” in history and run
detail. The original source retains its failed status and ×, with a separate
handling disposition; the handler keeps its own ordinary execution story.
Stopped handlers are not described as handled. A later run failure is not blamed
on a source whose failure was already handled. The summary count survives
retired step details without inventing missing execution evidence.

Local qualification uses the existing owned browser/API/PostgreSQL/Redis/worker
fixture. The browser creates an encrypted HTTP connection, authors
Webhook → Validate → Set → Condition → HTTP → Stop run, adds a separate Set
handler with the safe envelope, saves, reloads and publishes. A definite 401
selects the handler, skips the normal Stop run and succeeds with one handled
failure; the source stays failed. A 503 after an actual effect produces unknown
outcome, never runs the handler and exposes no recovery action. Independent
SQL checks verify the immutable executable, exact five-field failure value,
matching handler input/Condition scope, source disposition, one selection and
handling event, no success inbox notice and actual request/effect counts.

Mocked browser cases cover keyboard authoring/removal/undo on desktop and 375 px
with reduced motion, export/import of failure links and mappings, and truthful
handled history. Pure command tests also cover convergence refusal, guarded
handler ownership, copy remapping and unsafe field rejection. Screenshots use
synthetic fixtures only; live credentials, auth cookies and traces are not review
artifacts. The existing browser CI job includes the new scenario, with no new
job, service, role or runtime test hook.

Two pure extractions precede logic in separate commits: guarded editor removal
from command dispatch, and owned HTTP connection setup shared by browser cases.
React Doctor's changed-code scan is 100/100 without suppression. Local checks pass: `pnpm check`, 1,126 web units, 1,965 API units,
720 worker units and all 150 mocked browser cases. The new failure-routing and
existing signed-webhook/recovery browser scenarios pass separately against the
owned real stack. Before/after editor and handled-history review images are in
`docs/media/failure-routing/`. Required PR CI and natural postmerge results are
recorded in the slice PR; the merge gate above still applies.


## Follow-up — owner decision 2026-10-14

The owner approved manual recovery of a verified unknown-outcome target as an
amendment to ADR 072. Keep exact source input/version and reused prefix, original
unknown attention card and all existing graph/value/admission limits. No unknown
automatic retry or failure routing. A distinct `acknowledgeUnknownOutcome` is
checked in the acceptance transaction and bound to request identity; the run
summary and audit record its risk and acknowledgement. Existing commands without
the new field keep their hash.

- [x] Implement and qualify unsafe HTTP 5xx and post-dispatch network-loss
  recovery, refusal without the stronger acknowledgement (including with only
  `acknowledgePossibleEffects`), source preservation, prefix reuse, exact
  version/input, no automatic retry and phone keyboard confirmation.
- Later work only: per-step “safe to repeat” for idempotent requests. No setting
  or altered HTTP classification is included here.

Storage: extend the existing summary risk discriminator and its Drizzle SQL
constraint in additive migration 0007; no new table, role, format or subsystem.
Qualification uses the existing owned HTTP browser/worker/SQL fixture, with a
service effect followed by a 503 or deliberately lost socket response and an
explicit later successful manual retry. Local owner data/services are untouched.


Local follow-up qualification: the existing owned browser/API/worker/SQL case
passed with exactly seven controlled HTTP requests and six effects. The 5xx and
lost-response source each have five original attempts; their recovery each has
four attempt-free copies and only two new attempts (HTTP and terminal Stop).
Both refused missing or weaker acknowledgement with 409 before creating a run;
SQL verified the total run count, exact input/version, stronger-risk summary and
one acknowledged audit per recovery. Original source rows remain unchanged.
Phone keyboard confirmation uses 375 × 768 with reduced motion. Mocked desktop
and phone examples are [desktop](../media/unknown-recovery/confirmation-desktop.png)
and [phone](../media/unknown-recovery/confirmation-phone.png). React Doctor's
changed-code scan is 100/100 without suppressions. Full gate and required
CI/postmerge results belong to the delivery PR; merge is still gated on green CI.


CI qualification follow-up: the existing worker recovery integration still
asserted the superseded blanket unknown refusal. It now verifies the separate
unknown risk, absent/weaker acknowledgement refusal with no receipt, explicit
successful suffix execution, risk-specific audit and exact-request replay for
both dispatched definite and unknown targets. The scripted registry belongs
only to this existing integration test; the browser journey above separately
proves actual 5xx and post-dispatch socket loss. No production behavior is
changed to satisfy that stale assertion.


The existing failure-route browser scenario also expected every unknown run to
hide the recovery command. It now proves that the unchanged attention card is
visible and that this graph still refuses recovery as `unsupported_graph`
because it has failure links. The dialog offers separately confirmed full
replay and no acknowledgement checkbox; the unknown handler remains skipped.
The broader graph boundary is not relaxed by the new manual target decision.


## Follow-up — error workflows (owner request 2026-10-15)

Status: implementation authorized. This extends F09; it does not reopen the
existing failure-route or recovery decisions. F04 is delivered through PR #299.
The owner authorizes recommended internal design choices without a plan-approval
pause. Accounts, paid services and new infrastructure remain outside this work.

### Behavior and decisions

A workflow's Settings offers **When this workflow fails, run …**. The target
must be a different active workflow in the same workspace with a published,
single **When a workflow fails** (`core.workflow_error@1`) entry. Setting or
changing the target requires `workflow:update` on both workflows, rechecked
inside the authoring transaction. Clearing requires source edit access. Reads
require source read access. Current access is workspace-role based; this does
not introduce workflow ACLs or grant the target any extra authority.

The setting is operational metadata, like failure alerts and concurrency. It
is not part of the draft, portable graph or checksum. At terminal failure the
current setting and target's current publication are captured into one durable
intent. Changes after that point affect later failures only. The dispatcher
runs that exact captured version, with normal current lifecycle, workspace,
queue and credential checks. Archiving the target refuses pending admission;
it does not silently switch to another version or undo the source failure.

Terminal `failed`, `timed_out` and `outcome_unknown` count as failures, matching
existing failure notices. Successful handled failure routes and canceled runs
produce no intent. A failure after a handler itself fails produces one intent.
The unique source-run identity prevents repeated terminal delivery from creating
a second logical error run. Existing idempotent admission and its outbox commit
make a lost dispatch response safe to retry.

Runs admitted by this trigger carry an error-workflow origin. Child Calls
inherit it, so a failing child cannot start an indirect notification loop.
Replay/recovery of such runs retain that origin too. They still run normally,
and retain ordinary failure history and inbox notices, but never start another
error workflow. This is recursion prevention, not a new capacity exemption.
The source slot settles normally; the error run queues under normal limits.

### Safe trigger input

Only allowlisted metadata crosses the seam: source workflow ID and name,
source run ID and relative application run link, immutable version ID, terminal
status, failed step ID (nullable for run-level failure), and a sanitized error
**code and fixed application-owned description**. No run input, output, mapped
values, provider text, stack, URL query, HTTP body, connection or credential is
read or copied. Names are bounded authoring metadata, rendered as text. Unknown
codes use a fixed generic description; code syntax alone is not sanitization.
The safe envelope has one shared strict browser-safe schema used by the trigger,
producer and read projections. It stays within the existing value envelope.

### Placement and delivery

- `nodes-core/src/triggers/workflow-error/`: manifest, strict config/input/output
  validation and safe pass-through executor; register in the existing catalog.
  Extend existing trigger-source identities and editor labels/mapping examples.
- `database/src/authoring/settings/error-workflow.ts`: current policy read and
  idempotent edit through the existing authoring factory and membership locks.
- `database/src/schema/authoring/` and `schema/runs/`: policy and intent tables,
  forced workspace RLS, workspace-composite foreign keys and ordinary grants.
  Additive Drizzle migration, readiness head and existing schema checks.
- `database/src/runs/error-workflows/`: terminal producer, safe summary and
  transactional acceptance. Use the existing initial-checkpoint factory,
  admission, lifecycle locks, command receipts and queue outbox. Expose through
  `/runs` and `/authoring`; no new package or database door.
- `queue` and worker: one typed delivery job on an existing queue, no new queue,
  polling service or CI job. Transient infrastructure failures use existing
  transport retries; permanent target/queue refusal is recorded as such and
  visible in source run detail. A source failure always remains committed.
- `contracts`/API: strict Settings GET/PUT, paginated eligible-target discovery
  (`error-workflow/targets?after=…`) and safe run-detail delivery summary,
  generated OpenAPI, existing cookie/CSRF/idempotency/rate limits. Automation
  tokens keep their existing explicit scope rules.
- web: existing workflow Settings owns the selector and explanation; run detail
  owns captured/accepted/refused status and authorized run link. Query snapshots
  stay in TanStack Query. Keep Weft controls, narrow/mobile layouts and one
  feedback owner. Never expose a selected target as an access grant.

Retention deletes intents with their source summaries, keeping admitted runs
as independent ordinary history. Captured target versions remain pinned for their source intent’s retention window; workspace purge removes policy/intents in dependency order.
No provider account, external effect, image download or deployment is needed.

### Qualification and tracker

- [x] Reconcile current terminal producers, admission, Calls and authoring seams;
      record the owner scope and recommended decisions before implementation.
- [x] Implement catalog/model, additive storage, atomic producer/admission,
      authorization and safe contracts/API.
- [x] Implement Settings and source-run delivery feedback, user documentation.
- [x] Prove one admission across redelivery/concurrency/worker restart; source
      failure commits independently; archived/deleted/unpublished target,
      capacity and revoked-editor behavior; workspace isolation and purge.
- [x] Prove handled success/cancel exclusion, failed handler inclusion, direct
      and child/replayed error-origin suppression, and secret-bearing error
      text absent from the entire envelope.
- [x] Qualify a real failure → error trigger → mapped safe summary → successful
      action run using owned local fixtures; browser desktop/phone and keyboard.
- [x] Lint, types, units, mocked e2e, relevant live integration, changed React
      diagnostics.
- [x] Green PR CI, rebase merge and natural main result.

The existing F09 exclusions now defer *other* new triggers; this explicitly
requested trigger is included. Approvals/forms/variables/preferences follow
only after this follow-up is complete. Broader failure-route graphs and
file-aware recovery remain deferred.


Local qualification: the real browser creates/publishes the error trigger,
chooses it in Settings, saves/reloads at desktop and 375 × 768, starts a real
failing Summarize workflow, follows the admitted error run and checks its mapped
safe output. Independent SQL verifies exactly one intent, failed source,
successful `workflow_error` run and origin suppression. The real worker journey
also restarts maintenance with an intent pending and proves that a failing error
workflow does not start its configured fallback. PostgreSQL cases cover duplicate
concurrent deliveries, captured publication identity, all three failure statuses,
cancellation/handled-success exclusion, archived/unpublished/incompatible targets,
queue refusal, revoked membership, workspace isolation, replay/Call origin and
ordinary workspace purge. Pure summary cases distinguish a failed handler from
its pending source and a run-level deadline from an earlier failed step.

All 166 mocked browser tests pass. The full ordinary unit run passes 9,086 tests;
subsequent focused additions cover two construction-cleanup cases and one
run-level summary case. Lint, TypeScript, generated OpenAPI, typed schema inventory
(85 tables), dependencies and ownership checks pass. Changed React Doctor scope
is 100/100 with no suppressions. Final commit/pre-push and CI receipts are recorded
on the PR. [Review images](../media/error-workflows/README.md) use only owned
synthetic fixtures.

One prerequisite fix uses workflow-model’s canonical serializer for the static
API-token SQL scope constant. drizzle-kit adds an enumerable `Array.prototype.random`;
execution-value validation correctly rejects such inherited properties. The
static constraint needs canonical serialization, not execution input validation.
A regression proves its exact generated SQL under that tool behavior. Runtime
validation and stored formats are unchanged. An initial combined test run hit
an authoring-worker deadline while browser/lint work also ran; the isolated
42-case check and the subsequent ordinary full unit gate pass without changing
a timeout or validation policy.

CI's complete PostgreSQL suite found that the prerequisite shared serializer
still let `JSON.stringify` invoke inherited array `toJSON` during schema
constraint construction. The unchanged hostile-prototype admission test
reproduced this locally (two hook calls). The shared serializer now writes
normalized containers without calling their hooks; numeric-key ordering and
existing canonical bytes are preserved. Both new serializer regressions, all
282 model tests and all 16 real admission-persistence cases pass. The fix is a
new commit, with no test weakening or hook suppression.

[PR #300](https://github.com/vigani1/pertexo/pull/300) rebase-merged on
2026-10-15 at `d342d8982569fbf1033122970878aee9f22b0c53`. All required PR
checks passed. The natural [main CI run](https://github.com/vigani1/pertexo/actions/runs/38695255050),
including ARM images, passed too. Error workflows is complete; the next
authorized feature is F10.

### F11 Form replay boundary — 2026-10-15

[ADR 077](../adr/077-form-submission-and-input-tasks.md) requires a Form replay to
retain its exact source version and captured input while that input remains
available. New form values go through a new submission, preserving server-owned
submitter/time metadata. Other full replays keep their existing explicit input
behavior. Approval and Request input graphs remain outside prefix recovery.

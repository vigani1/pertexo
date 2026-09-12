# Ordered implementation work packages

Status: **planned, not implemented or authorized**. This is the execution map
for the [whole-codebase review](../whole-codebase-quality-plan.md), not a second
set of findings. The [finding index](finding-index.md) locates each WQ record;
its primary ledger and shared extensions contain the exact source/test paths,
symbols, observed code, proposed code or control-flow shape, preserved contracts
and detailed regression matrix. Those requirements remain binding here.

All 232 WQ records have exactly one primary package in the ownership table.
PF-01–PF-07 and WF-S01 retain their detailed
[structural plan](../structural-follow-up-plan.md), with integration placement
below. A work package is a cohesive review area, **not a required single commit**
or an instruction to change every file in it. Keep bug fixes with their tests;
separate behavior-preserving cleanup and conditional optimizations when they can
be reviewed independently. No fixed commit count or speculative speed estimate.

The per-file tables also contain localized TEST/REFACTOR/CONDITIONAL follow-ups
without a new WQ identifier. They belong to the package linking that area ledger
and are not discarded by this WQ ownership map. KEEP rows require no edit unless
a separately documented finding explicitly reaches that file.

## Execution rules and gates

1. Refresh `git status`, the applicable source/ADRs and affected inventory hashes
   before each package. Line numbers identify the reviewed snapshot; symbols and
   paths are the durable anchors. Do not overwrite intervening user work. Do not
   renumber or edit published migrations to match this plan.
2. Run the narrowest regression for the confirmed failure first, then the fix,
   related negative/compatibility cases and owning package checks. This is change
   verification at established seams, not a new repository-wide test framework.
3. **Isolation before destructive evidence:** before any suite that changes
   grants/schema, pauses/stops Redis, deletes tenant rows, consumes queues or
   kills processes, implement its ledger's fixture-ownership prerequisite.
   Use private databases/queue namespaces/object prefixes and owned children;
   fail rather than silently target shared defaults. These prerequisites belong
   to the API/database package that owns the suite and Q02 for worker suites.
   Do not postpone them merely because their owning package appears later.
4. **Actual settlement before release:** cancellation/timeout regressions must
   distinguish requesting abort, observing rejection, underlying settlement and
   disposal. A `Promise.race` win is not proof of resource release. Preserve the
   initiating error even when it is `undefined`; record cleanup failure
   separately. Run hostile-throw tests in bounded, isolated harnesses.
5. **Forward-only SQL:** allocate the next migration number from the then-current
   head. Preserve role grants, search path, signatures, RLS and lock authority.
   Coordinate effective function replacements in Q10/Q11/Q12/Q35 so a later
   replacement cannot restore an older bug. Test both real serving roles and
   maintenance roles; owner-only malformed-row probes are separate evidence.
6. **Contracts before optional changes:** CONDITIONAL findings first resolve
   their precise contract/measurement gate. KEEP is a valid completed outcome
   when the gate fails, with the measured result and reason recorded. Never
   count a requested test or readability proposal as a reproduced runtime bug.
7. **Evidence before qualification:** Q01 precedes mutation execution; Q37/Q40
   precede relying on new aggregate quality/performance evidence. Do not rewrite
   historical reports to make old results claim the newly strengthened proof.
8. Complete required package build/typecheck/tests and relevant export,
   architecture, schema and documentation gates. Record commands, source
   identity, executed versus inspected suites and unavailable external evidence.
   Full local qualification and deployment qualification remain different.

## Primary ownership and default order

Start with the safety prerequisites, then the P1-bearing packages Q03–Q16.
Within those packages, do the specified correctness slice before their P2/P3
cleanup. Q10's PF-04 and Q09's PF-05 remain the first two **durable-state** fixes
from the structural plan; Q03's privacy fix and safe independent work can run
without waiting on database qualification. There is no requirement to finish
every optional subitem in an earlier package before starting a later urgent
fix. Dependencies below and per-suite isolation gates take precedence over
simple numeric order.

| Package | Primary WQ ownership | Structural integration | Scope |
| --- | --- | --- | --- |
| Q01 | WQ-223–WQ-227 | PF-03 coverage evidence | Safe quality execution and trustworthy coverage |
| Q02 | WQ-114–WQ-128 | — | Worker integration ownership and proof fidelity |
| Q03 | WQ-018–WQ-021 | PF-02 | Logging privacy and nonthrowing inspection |
| Q04 | WQ-046–WQ-050 | PF-01, PF-03 | Operational entrypoints, restore and shutdown |
| Q05 | WQ-055–WQ-060 | PF-02, PF-03 | API platform authority and resource lifecycle |
| Q06 | WQ-106–WQ-110 | — | Production attempts and capability ownership |
| Q07 | WQ-111–WQ-113 | — | Preview dispatch authority and actual work ownership |
| Q08 | WQ-100–WQ-101 | PF-02 | Worker diagnostics outcome preservation |
| Q09 | WQ-037–WQ-045 | PF-05, WF-S01, PF-06 | Engine state truth and explicit control flow |
| Q10 | WQ-206–WQ-211 | PF-04 | Effective SQL predicates, IDs, leases and purge |
| Q11 | WQ-193–WQ-202 | — | Retention, control ledger and workspace lifecycle |
| Q12 | WQ-181–WQ-185 | — | Coordinator transaction and observation boundary |
| Q13 | WQ-064–WQ-067 | PF-02 | API connection command and provider ownership |
| Q14 | WQ-091–WQ-099 | PF-03 | Worker platform, outbox and transport lifecycle |
| Q15 | WQ-102–WQ-105 | PF-03 | Coordinator, trigger and notification supervision |
| Q16 | WQ-129–WQ-139 | PF-02 | Database foundation, readiness and migrations |
| Q17 | WQ-001–WQ-007 | — | Rate-limit, SDK and catalog boundaries |
| Q18 | WQ-008–WQ-013 | PF-07 | Core-node/model bounded admission and evaluator |
| Q19 | WQ-014–WQ-017 | — | Queue lifecycle and error contracts |
| Q20 | WQ-022–WQ-027 | — | Artifact adapter cancellation and replay |
| Q21 | WQ-028–WQ-036 | — | Integration/provider semantics and inspection |
| Q22 | WQ-051–WQ-054 | — | Public contract validation |
| Q23 | WQ-061–WQ-063 | — | API artifacts and catalog |
| Q24 | WQ-068–WQ-074 | — | API identity and workspace authorization |
| Q25 | WQ-075–WQ-078 | — | API schedule and webhook boundaries |
| Q26 | WQ-079–WQ-081 | — | Preview API admission and replay |
| Q27 | WQ-082–WQ-084 | — | Workflow authoring API |
| Q28 | WQ-085–WQ-090 | — | Execution streams and authorization refresh |
| Q29 | WQ-140–WQ-146 | — | Database identity and connections |
| Q30 | WQ-147–WQ-153 | — | Publication and release compatibility |
| Q31 | WQ-154–WQ-162 | — | Database trigger reconciliation and schedules |
| Q32 | WQ-163–WQ-170 | — | Run admission, events and transport persistence |
| Q33 | WQ-171–WQ-177 | — | Operator commands and artifact finalization |
| Q34 | WQ-178–WQ-180 | — | Notification persistence and audit identity |
| Q35 | WQ-186–WQ-192 | — | Node attempt and preview persistence |
| Q36 | WQ-203–WQ-205 | — | Historical migration and semantic SQL evidence |
| Q37 | WQ-212–WQ-216 | — | Local gates and machine-evidence validation |
| Q38 | WQ-217–WQ-219 | — | Deployment contracts and startup smoke |
| Q39 | WQ-220–WQ-222 | — | Operational exercises and telemetry qualification |
| Q40 | WQ-228–WQ-230 | PF-06 measurement prerequisite | Benchmark source, measurement and ownership |
| Q41 | WQ-231 | — | Ordinary PR CI invariants |
| Q42 | WQ-232 | — | Live guidance and historical supersession pointers |

## Safety and urgent correctness slices

### Q01 — quality execution and coverage trust

Owners: [quality runner](infrastructure-quality-runner.md) and
[coverage evidence](infrastructure-coverage-evidence.md). First isolate every
explicit snapshot/source Git command from inherited Git overrides. Assert an
independent control repository's HEAD, index and configuration remain unchanged;
only the owned snapshot may receive synthetic mutation commits. No mutation
execution before this passes. Then derive qualification requirements from trusted
cohort definitions, make lock/output/process ownership complete, fingerprint
exact source semantics and bind generated evidence to real source/execution.
Acceptance includes downgraded required flags rejected, empty/malformed counters
handled explicitly, literal-only code changes invalidating stale justifications,
bounded output with trailing bytes retained, and timeout/cleanup errors never
reported as success. Q37 supplies shared evidence-shape validation; PF-03's
entrypoint tests must be mapped into real coverage rather than merely named.

### Q02 — worker integration isolation and meaningful proofs

Owners: [transport](worker-transport-integration.md),
[coordinator](worker-coordinator-integration.md),
[preview](worker-preview-integration.md),
[lifecycle/artifacts](worker-lifecycle-artifact-integration.md),
[schedules](worker-schedule-integration.md), and
[HTTP](worker-http-integration.md). Implement fixture acquisition/cleanup fixes
before each affected suite runs: private queue consumers, owned workspaces and
objects, child waits registered before signals, immediate cleanup registration,
and actual child exit before deleting its state. Enforce recovery admission
deadlines and release the schedule benchmark gate before runtime drain.
Then separate queue deduplication from real handler redelivery, replay from
fresh execution, and crash-boundary evidence from eventual happy-path recovery.
Acceptance: fail each acquisition/assertion/teardown step without touching a
sentinel sibling fixture; no retained listeners/timers/children; handler invocation
counts and durable attempt/event/audit identities prove the named behavior.
Keep domain assertions in scenarios; share only repeated fixture mechanics.

### Q03 — privacy and diagnostics normalization

Owner: [observability](observability.md), with PF-02's process/error-name sites.
Fix Nest credential redaction before its shorter display truncation first.
Then protect the entire unknown-value classification boundary and cap value
inspection before enumeration/access, including secret-named properties.
Acceptance: sentinel credential prefixes never appear for delimiters before,
at or after truncation; output remains bounded; hostile/revoked proxies and
throwing properties cannot replace a caller outcome; ordinary correlation and
trusted errors remain useful. Test actual Nest summary/context/stack paths.
Apply the inspected PF-02 sites without exporting a general error framework or
pretending destination-write failures have the same policy as inspection.

### Q04 — operational entrypoints and restore

Owner: [operational apps](operational-apps.md) plus PF-01/PF-03.
Attempt every pre-handoff close even when another close/log fails; register
handoff before fallible post-start reporting; await every started maintenance
child before releasing its dependencies. Require `signal.aborted` before
interpreting its reason as cancellation. Expand restore inventory proof beyond
one artifact and preserve ordered restore-before-serving behavior.
Acceptance: per-app partial-acquisition/handoff/signal matrix executes the real
app-owned orchestration, retains initiating failure and cleanup failures in
defined order, and closes each owner once. Zero, multiple, missing and mismatched
restore artifacts produce the correct readiness outcome. PF-03's exact coverage
plumbing is required. Keep operator command translation and audit projection
local; do not replace distinct command policies with a generic dispatcher.

### Q05 — API platform

Owner: [API platform](api-platform.md); depends on Q03 only for shared
normalization semantics, not permission to move API policy into logging.
Make close attempt all owned resources, prevent a late health result from
restoring readiness after drain, and keep rate-limit diagnostics outside
allow/refuse authority. Protect hostile unknown errors at the public filter.
Acceptance: synchronous and asynchronous failure of each closer does not skip
siblings; repeated close observes the same in-flight completion; drain during a
pending health check remains unready; throwing diagnostics cannot admit a
refused request or change the original response. Own partial test startup and
scope Redis fault injection before integration runs. Improve test specificity
without weakening public error/correlation contracts.

### Q06 — production attempts and capabilities

Owner: [node execution](worker-node-execution.md). Protect heartbeat acquisition
and supervision, reserve the per-attempt dispatch marker synchronously before
awaiting authorization, and stop connection work at observed cancellation.
Close every owned artifact stream and clear every owned chunk, including an
overflow chunk. Preserve the distinction between cancellation and an unsafe
provider outcome that still requires reconciliation.
Acceptance: concurrent capability calls obtain at most one dispatch permission;
early/mid-await abort makes no later prohibited connection/provider call;
heartbeat startup failure and late settlement leave no unowned heartbeat or
stream; cleanup cannot erase durable outcome truth. Apply the detailed
safe/idempotent/unsafe tests before local phase/predicate cleanup. Coordinate
authority projection with Q07/Q29 and artifact ownership with Q20/Q33.

### Q07 — preview execution

Owner: [preview runtime](worker-preview-execution.md). Forward the existing
preview dispatch authority and provider binding rather than reconstructing a
weaker capability context. Supervise actual invocation/heartbeat work after the
timeout winner and preserve ownership through shutdown. Reject unsupported
configuration versions through the real registry seam.
Acceptance: captured connection calls receive every required authority field;
no invocation/heartbeat begins after the relevant stop boundary; late work is
observed and disposed; unsafe outcomes remain truthful; concurrent dispatch
matches Q06's reservation rule. Q26 owns API replay/config admission and Q35
owns persisted output/replay truth; test the end-to-end combination after those
slices, with Q02's private preview fixtures.

### Q08 — worker provider telemetry

Owner: [worker telemetry](worker-telemetry.md), coordinated with Q03/Q13/Q21.
Contain span start/attribute/record/end and error classification without retrying
the business callback after a diagnostic failure. Add tests for each diagnostic
phase, not only span construction.
Acceptance: exactly one provider/HTTP operation executes; its result or original
rejection is preserved when any telemetry phase throws, including hostile
rejection values; no sensitive provider input escapes. Keep provider policies
distinct and retain existing coordinator/trigger containment where already sound.

### Q09 — engine state truth, then readability

Owner: [engine](workflow-engine.md) plus PF-05, WF-S01 and conditional PF-06.
Integrate PF-05 stop precedence with WQ-045's running For Each truth: stop new
admission but retain running body/ordinal state until real outcomes arrive.
Never relax database validation to accept invented running completions. Next
repair timestamp/outer-array admission, traversal exit frames, conflicting
upstream descriptors, root-scope identity and hostile-error classification.
Acceptance: every cancel/deadline/late-outcome plan for ordinary and nested
loops commits through the real coordinator, starts no new body work and
preserves unknown-outcome precedence, budget and replay identity. Pure decoder
tests cover invalid dates, accessor arrays and duplicate/conflicting output.
Only then simplify the two identified dense expressions and misleading tests.
WF-S01 requires its consumer/compatibility search. PF-06 runs only after Q40's
measurement fixes and its existing selection threshold; retain scans if not met.

### Q10 — effective SQL fixes and purge

Owners: [execution SQL](database-migrations-execution.md),
[retention SQL](database-migrations-retention.md),
[operations SQL](database-migrations-operations.md) and PF-04.
Coordinate PF-04's missing maintenance-rerun table with WQ-211's current-attempt
pointer and preview FK deletion order in one reviewed effective purge function.
Separately forward-fix nullable JSON/CHECK predicates, NULL recovery bounds,
NULL lease credentials, notification connection UUIDv7 and artifact-reference
UUIDv7 locking. Do not mechanically replace every comparison or regex.
Acceptance: populated, paged tenant purge reaches its intended terminal state
without bypassing residual checks or deleting preserved control evidence;
malformed/NULL lease calls cannot read protected data or mutate authority;
valid v4/v7 paths work; wrong-tenant/missing/deleting artifact references fail;
two real clients prove reference locking against deletion. Invalid CHECK input
must be false/rejected, not SQL NULL accepted as unknown. Preserve grants/RLS,
append repair, parameterization and bounded page work. Q11 supplies the external
ledger race proof that SQL alone cannot establish.

### Q11 — destructive authority, ledger and lifecycle

Owners: [retention](database-retention.md),
[control ledger](database-control-ledger.md),
[workspace lifecycle](database-workspace-lifecycle.md),
[cross-cutting evidence](database-crosscutting-tests.md), and
[retention integration](database-retention-integration.md).
First preserve external-ledger freshness across destructive authorization and
discard clients after failed rollback, even an `undefined` rejection. Propagate
actual SQL cancellation and retain ownership through lifecycle failure. Then
separate durable command/purge phases and make result/evidence names truthful.
Acceptance: an observed external ledger/hold advance between eligibility and
destruction prevents deletion or is excluded by demonstrated authority
serialization; no transaction is held across unbounded external I/O; rollback
failure always discards the client; canceled maintenance cannot continue
unobserved SQL. Real role/lock/barrier tests must prove the exact race and
preserved capacity/reference/hold/replay invariants. Benchmark setup must not
adaptively change the workload until it passes. Q10 and Q33 share invariants,
not a new generalized lifecycle framework.

### Q12 — coordinator store

Owner: [coordinator database](database-coordinator.md). Remove row locks from
the read-only observation transaction while retaining the later authoritative
commit-phase reference locks and validation. Bound/decouple optional post-commit
metrics so they cannot hold an acknowledged operation indefinitely. Distinguish
canonical protocol limits from larger encoded/materialized wire limits.
Acceptance: actual read-only snapshots with artifacts succeed; a retention race
still fails safely at authoritative commit; a stalled metric cannot retain the
client/transaction or hide committed success; threshold tests cover canonical
and wire sizes independently. Then simplify repeated local lookups and phases,
preserving ordering and ownership. Q09's loop fix requires this store's real
transaction proof; Q02 and this ledger own its fixture prerequisites.

### Q13 — API connection commands

Owner: [API connections](api-connections.md). Prevent tracing failure from
repeating/replacing a connection command. Own partial provider construction and
defer each close invocation so synchronous failure cannot skip another owner.
Acceptance: one command and one provider action under failures at every tracing
phase; all acquired resources receive cleanup attempts; caller outcome and
authorization remain unchanged. Separate destination transport from context
projection only at the identified local seam. Keep provider-specific status,
redirect and credential policy in its existing owner; Q21 tests those policies.

### Q14 — worker platform and transport

Owners: [worker platform](worker-platform.md) and
[transport](worker-transport.md). Forward workspace transaction options through
the Nest adapter; revoke readiness and signal drain independently of logging;
bound readiness and resource-sampling timers to actual runtime limits. Own every
dispatcher operation, reject new work after close and close transport dependencies
in safe order. Bound actual capacity sampling, not just its awaiting promise.
Acceptance: adapter preserves signal/deadline options; drain wins a pending
health check; overflowing timer intervals reject; repeated close shares real
completion; shutdown observes in-flight dispatch without post-close admission
or accumulating timed-out samplers. Preserve durable unknown-publication leases
and redelivery semantics. Q19/Q32 own queue/database behavior; PF-03 tests real
entrypoint handoff instead of a parallel test-only orchestration.

### Q15 — coordinator, trigger and notification supervision

Owners: [coordinator/triggers](worker-coordinator-triggers.md) and
[maintenance/notifications](worker-maintenance-notifications.md).
Own each started runtime and outstanding scan, make logger failure unable to
terminate required work or skip close, and prevent readiness after stop. Distinguish
notification delivery deadline from merely requesting cancellation.
Acceptance: partial startup and stalled scan/heartbeat/provider cases settle or
remain explicitly owned through bounded shutdown; a second intended retry really
reaches its provider; ambiguous dispatch preserves the existing provider-specific
retry policy. Keep meaningful branches; extract only the named local phases and
fixture mechanics. Coordinate Q14/Q21 and do not turn all provider failures into
one generic retry decision.

### Q16 — database foundation and startup contracts

Owners: [foundation](database-foundation.md),
[readiness](database-readiness.md),
[migration runner](database-migration-runner.md), and
[schema surfaces](database-schema-surfaces.md). Contain pool diagnostics, release
the shared sampler at most once per owner and preserve migration failure across
cleanup. Strengthen startup catalog predicates to their claimed invariant; keep
package-contract tests genuinely offline and schema inventories complete.
Acceptance: hostile diagnostics cannot bypass disposal; repeated pool close
cannot release another owner's sampler; acquire/query/rollback/close failures
retain their distinct cause and timeout truth; isolated drift tests distinguish
actual ACL/RLS/signature/body invariants from mere names or substrings. Test
actual build exports after building. Nontransactional migration modes remain
CONDITIONAL until their exact partial-failure/resume semantics are qualified;
do not introduce them merely because a declaration exists.

## Boundary and maintainability packages

### Q17 — rate-limit, SDK and catalog

Owners: [rate-limit](rate-limit.md), [SDK](node-sdk.md),
[catalog](node-catalog.md). Prove failed/timed-out Redis QUIT disposal before
adding a fallback; KEEP if the pinned dependency already guarantees it. Reject
duplicate definition policies and inspect/measure the same immutable JSON
snapshot with protected failure normalization. Separate registry construction
phases and validate a release once per catalog projection.
Acceptance: equal-looking duplicate policy lists reject; getter/mutation probes
cannot make measured and accepted material differ; hostile throws remain safe;
catalog contents/order and browser/server exports do not change. Test behaviors
independently instead of relying on misleading test names or global mutation.

### Q18 — core nodes, model and evaluator

Owners: [core nodes](nodes-core.md), [workflow model](workflow-model.md) and
PF-07. Apply bounded JSON admission before recursive For Each/schema parsing;
make browser/server draft limits agree; protect graph parsing against secondary
inspection and rereads. Retain evaluator worker ownership until termination
actually completes. Clarify code-point counting without changing rule precedence.
Acceptance: adversarial depth/width returns the defined invalid result without
stack overflow or accessor execution; boundary-size parity holds in both
environments; timed-out evaluators are reaped; own-array mapping behavior is
explicit. PF-07 first resolves the accessor-versus-canonical-JSON contract;
neither contract may be silently inferred from this cleanup package.

### Q19 — queue adapter

Owner: [queue](queue.md). Ensure close wins pending readiness; guard error
classification and immediately observe all fallback-disconnect rejections.
Acceptance: a delayed ready event cannot reopen a closed adapter; ordinary
results and original errors survive hostile classifiers; synchronous/async
disconnect failures are observed with no orphaned promises; cleanup tests own
their fixtures and run independently. Retain the existing producer/deduplication
contract; use Q02 to prove redelivery at the worker handler, not this adapter.

### Q20 — artifact adapters

Owner: [artifact store](artifact-store.md). Observe an already-started operation
even when cancellation already won, protect classification as well as telemetry,
compare normalized replay material and PUT verification metadata exactly.
Acceptance: pre-abort/late-rejection permutations produce no unhandled rejection;
changed normalized ledger material conflicts; content/size/hash metadata mismatch
cannot report verified success. Preserve original errors, stable public policy
and minimized diagnostic output. Stream ownership extensions are conditional on
the precise coordinator contract; coordinate Q06/Q33 instead of introducing a
universal stream owner. Test cleanup even when setup or assertions fail.

### Q21 — provider and network integrations

Owner: [integrations](integrations.md). Preserve Resend refusal status when its
body is malformed, historical dispatch uncertainty across retries, and blocked
redirect dispatch context. Make URL validation and unknown-error classification
total at their intended seams; bound crypto preflight and clear owned temporary
buffers. Qualify late transport-response ownership before changing it.
Acceptance: malformed bodies do not turn definitive refusal into a different
retry class; unsafe prior dispatch remains uncertain where required; literal
redirect refusal retains context; hostile throws cannot strand work; exact
buffer cleanup runs on every failure phase. Share Slack envelope parsing only,
not Slack/Resend/HTTP retry authority. No external provider request is necessary
for the local deterministic regressions.

### Q22 — contracts

Owner: [contracts](contracts.md). Count complete Unicode in connection-test URL
bounds, preflight node-test JSON before recursive validation, and encode the
replay/credential exclusion in structural alternatives.
Acceptance: real code-point and depth/width boundaries are tested; forbidden
credential-plus-replay combinations reject; accepted wire shapes, error paths
and ordinary defaults remain compatible. Each negative case changes one
invariant. Coordinate Q18/Q26/Q35 for one output/input contract, not copied
slightly different limit constants.

### Q23 — artifact and catalog API

Owner: [API artifacts/catalog](api-artifacts-catalog.md). Preserve authorization
failure across artifact verification, including revalidation after external I/O.
Acceptance: revoked/wrong-workspace authority is not converted into a generic
artifact result; fixtures own partial acquisition; metadata and response contracts
are asserted independently. Simplify only the inspected catalog comparator and
prove actual tie/order behavior. Coordinate Q20/Q33; do not remove necessary
two-phase authorization because it looks duplicated.

### Q24 — identity and workspace API

Owner: [identity API](api-identity-workspaces.md). Match an authorization proof
to the requested lifecycle policy; reconcile the OAuth callback wire schema
without breaking provider protocol; clarify OIDC transaction states and encrypted
material ownership. Evaluate the unused audit facade against real consumers
before deciding removal.
Acceptance: an existing proof cannot satisfy a stronger/different policy merely
because it exists; real callback variants satisfy the selected contract; crypto
temporary cleanup and stable public failures hold. Make unit scenarios specific
and real-API stories independent with complete setup ownership. Q29 supplies
database session/cancellation and dispatch-order proofs; preserve required
audit facts even if an unused facade is removed.

### Q25 — trigger API

Owner: [schedule/webhook API](api-schedules-webhooks.md). Make diagnostics unable
to govern webhook acceptance; name normalized management material and explicit
output contracts. Acceptance: logging/tracing failure leaves the authoritative
accept/refuse result unchanged; tests assert the actual interface and exact
response, replay and authorization facts; direct-webhook integration has private
resources and bounded teardown. Coordinate Q31's asynchronous reconciliation
contract, never infer synchronous projection from an older blueprint example.

### Q26 — preview API

Owner: [node-testing API](api-node-testing.md). Validate selected-node config
identity and resolve exact preview replay before mutable-draft admission.
Acceptance: identical admitted request can replay after unrelated draft mutation
under the existing authorization/retention rules; changed request identity still
conflicts; incompatible config versions reject before invocation. Distinguish
these from credential replay exclusion in Q22 and terminal output identity in
Q35. Only then perform the specified small control-flow/test cleanup.

### Q27 — authoring API

Owner: [workflow authoring API](api-workflow-authoring.md). Resolve full-tag
versus revision-only save authority from ADR 011 and actual callers before
changing comparison semantics. Keep required strong `If-Match`; this is not
permission to revive a public `expectedRevision` body.
Acceptance: missing/malformed/stale/cross-identity tags exercise their exact
response; valid saves preserve CAS and replay behavior. Improve authoring
locality and assertions without moving database transaction policy into a
controller. Isolate lifecycle fixtures before their destructive checks. Update
live guidance only after the chosen compatible behavior is verified.

### Q28 — execution streaming

Owner: [execution/run API](api-executions-workflow-runs.md). Settle iterator
failures without inspecting rejection values unsafely; prevent refresh spinning
against an unchanged expiry; own stream acquisition and bounded teardown;
isolate visibility metrics from delivery.
Acceptance: undefined/hostile iterator failures preserve intended outcome;
unchanged-expiry refresh does not busy-loop; disconnect/abort during acquisition
or pending reads cleans owned listeners/timers/iterators without hiding live
work; a stalled/throwing metric cannot terminate the event stream. Preserve
authorization revocation and replay/rollout semantics. Q32 supplies snapshot
metadata consistency; do not hide an inconsistent page by formatting it away.

### Q29 — database identity and connection authority

Owners: [tenant access](database-tenant-access.md) and
[connections](database-connections.md). Use the established cancellation-aware
transaction owner for session lookup, reject invalid dates/bounded metadata
before work, and expose local identity result states. Qualify credential and
authority ordering at actual dispatch admission.
Acceptance: pre-abort starts no lookup; mid-flight cancel owns query cleanup;
invalid date/deep metadata fails before database work; rotation/revocation races
have an observed lock/order proof and preserve exact replay/tenant invariants.
Retain distinctions between missing, unavailable, revoked and incompatible
connections. Use historical fixtures only for the migration/upgrade proof that
needs them, without deleting that proof.

### Q30 — authoring and compatibility persistence

Owners: [database authoring](database-authoring.md) and
[compatibility](database-compatibility.md). First discard compatibility clients
after rollback failure and preserve diagnostic causes under fail-closed release
checks. Specify database-versus-engine checkpoint validation coverage, including
the Merge discrepancy, before moving validators. Then localize compatibility
normalization and measure publication retained-history work.
Acceptance: no dirty client returns cleanly to a pool; unsupported/corrupt
checkpoints cannot evade downstream admission; rollout/rollback assertions are
independent and observe durable state. History optimization proceeds only when
its memory/work improvement preserves corruption detection and exact publication
semantics; otherwise KEEP the current validation. Coordinate Q09/Q12 contracts.

### Q31 — trigger and schedule persistence

Owners: [workflow/webhook triggers](database-workflow-webhook-triggers.md) and
[schedules](database-schedules.md). Validate constructor material before pool
acquisition, unify webhook replay lock/read/expiry decision, and own cancellation
plus all claimed schedule work. Name reconciliation dispositions and command
phases without merging distinct lifecycle policies.
Acceptance: invalid construction leaks no pool/monitor; exact replay and expiry
use the intended time authority under contention; abort/recurrence failure
settles all claimed work without post-cancel admission. Graph-disabled trigger
behavior requires its explicit contract decision. Recurrence optimization needs
the existing semantic/measurement envelope and KEEP fallback; preserve DST,
misfire, calendar, fairness and cursor behavior with deterministic fixtures.

### Q32 — admission, event reads and transport

Owners: [value readers](database-execution-values-readers.md),
[run admission/events](database-run-admission-events.md) and
[database transport](database-transport.md). Bound admission-error inspection
and transport JSON before recursive work; validate claimed-result material before
COMMIT where its contract requires rollback on invalid material. Specify the
snapshot consistency of run reads and event-page metadata.
Acceptance: original rejection survives hostile details; malformed transport
cannot cause unbounded parsing or acknowledge invalid decoded claims; concurrent
page reads produce the selected coherent snapshot contract; replay-validation
modes and notification pin eligibility remain exact. Preserve parameterization,
fairness, leases, inbox atomicity and lost-ACK fencing. Strengthen claims using
owned, isolated contention fixtures, not sleeps or success-only assertions.

### Q33 — operator and artifact database owners

Owners: [operator](database-operator.md) and
[artifacts](database-artifacts.md). Propagate actual cancellation and make pool
shutdown truthful; validate bounded operator JSON without silently rewriting
audit evidence; protect unlock-error inspection so disposal always occurs.
Carry finalization cancellation through short phases while retaining authority
and metadata revalidation after external verification.
Acceptance: canceled SQL remains owned to settlement; repeated close reflects
completion; hostile/undefined cleanup failure discards contaminated clients;
revocation/change after verification prevents finalization; command conflicts
retain the intended committed audit before public rejection. Separate phases
locally, not by weakening the transaction or session-lock ownership contract.
Coordinate Q11's external deletion race and Q20's stream contract.

### Q34 — notification persistence

Owner: [database notifications](database-notifications.md). Validate finite,
bounded completion timing/attempt controls at the database seam and correct
audit target identity. Name destination command phases without collapsing
provider-specific states.
Acceptance: invalid delay/count/time is rejected before mutation; each audit
target matches the actual destination/command contract; retry/replay/lease and
provider snapshot invariants are independently asserted. Q10's UUIDv7 fixes
must cover destination, run pin and admission lookup together. Q15/Q21 verify
that delivery outcomes and historical uncertainty remain consistent end to end.

### Q35 — node attempt and preview persistence

Owners: [node attempts](database-node-attempts.md) and
[preview store](database-preview.md). Share one bounded preview output contract,
compare terminal duplicate durable identity/value, and persist the canonical JSON
envelope once while reading retained legacy encoding compatibly. Resolve preview
expiry-versus-fencing behavior at its exact ownership gate before changing it.
Acceptance: conflicting terminal output is rejected, exact duplicate is stable,
deep/invalid output returns a total validation failure, new records are not
double-encoded and valid retained records still decode. Real claim/dispatch/
completion tests preserve attempt fences, immutable inputs and output identity.
Local outcome projection cleanup must not fragment a transaction. Coordinate
Q07/Q22/Q26 and ensure test scenarios do not depend on another scenario's rows.

## Tooling, historical evidence and documentation packages

### Q36 — historical SQL evidence

Owners: [static migration tests](database-static-migration-tests.md) and
[foundation SQL](database-migrations-foundation.md). Keep historical source-text
smoke tests but add effective semantic/role evidence. Qualify populated historical
upgrades under the actual owner RLS context and OIDC capacity lock-time freshness.
Acceptance: the named pre-migration heads contain realistic multi-workspace rows;
upgrade assertions count transformed and retained rows and permissions, not just
successful empty bootstrap. An old migration that fails before the appended
repair requires a supported upgrade/remediation decision, not silent editing of
published history or a claim that a later migration solves it. Capacity contention
must observe real blocking/time advance before proposing an optimization.

### Q37 — local gate correctness

Owner: [infrastructure gates](infrastructure-gates.md). Own temporary repos and
directories, bound subprocess completion, resolve fragment-only Markdown links
against their current document, make complexity observations uniquely addressable
and validate evidence shapes before aggregation.
Acceptance: success and failure fixtures clean their owned paths only; hanging
children are terminated/reaped with accurate failure; same-file fragments resolve
correctly; distinct same-name/same-line observations cannot overwrite one another;
missing, duplicate and malformed evidence cannot become a passing aggregate.
Coordinate Q01's exact source fingerprint and Q41's CI gate invocation. Scores
remain navigation/evidence, never a substitute for manual code judgment.

### Q38 — deployment and startup evidence

Owner: [deployment infrastructure](infrastructure-deployment.md). Test semantic
deployment constraints rather than string presence/counts; validate external
evidence against the exact required policy coverage/provenance; own smoke-test
acquisition and meaningful readiness for HTTP and non-HTTP processes.
Acceptance: weakened policy/role/constraint fixtures fail for the intended reason;
missing or self-attested evidence cannot satisfy a stronger claim; partial image/
process startup cleans up; readiness cannot be inferred merely from process
existence. Actual AWS/IAM/network/container qualification requires its separate
environment and authority. Do not make a local structural validator claim those
external observations occurred.

### Q39 — operational exercises and telemetry

Owner: [operations infrastructure](infrastructure-operations.md). Reserve an
evidence destination without overwrite before costly/side-effecting work; separate
exercise scheduling, outcomes and evidence arithmetic. Qualify metric aggregation
and alert meaning across multiple writers.
Acceptance: an existing destination fails before resources/actions start; failed
write removes only the new owned incomplete reservation; scheduling and aggregate
counts agree under partial failure; two-writer/reset/stale-series scenarios prove
the specified alert policy rather than a single writer's happy path. No new alert
threshold or monitoring policy should be guessed. Coordinate Q40 output ownership
and retain explicit local versus deployed telemetry evidence labels.

### Q40 — benchmark correctness before optimization

Owner: [performance infrastructure](infrastructure-performance.md). Bind evidence
to source/build identity before and after measured work; separate fixture/warmup
SQL from measured scope and do not call statement-count deltas generic network
round trips. Observe promises immediately and close every constructed/acquired
sampler, monitor, process and output owner on partial failure.
Acceptance: source/build drift invalidates a run; no-observation process evidence
and malformed/missing required plans fail validation; manifest concurrency is
rejected if the ready-barrier protocol cannot represent it; waiter rejection
during a hold is observed immediately; failed second connect still receives
cleanup; commands/SQL have actual cancellation and bounded ownership. Preserve
valid zero CPU/terminal samples while requiring real workload observations.
Only after this can PF-06 and conditional Q18/Q30/Q31 optimizations cite new
measurements. Repeated lookup savings alone do not establish a latency win.

### Q41 — ordinary PR gates

Owner: [root/CI](root-and-ci.md). Add the missing service-free architecture,
built-export, local-quality-definition and performance-definition checks to
ordinary PR CI, with build before checking built exports. Do not replace these
with an expensive full qualification run or rely only on weekly/manual release.
Acceptance: a parsed workflow/policy test sees each required gate on the PR path
and rejects its removal; protected context names remain compatible. External
branch protection or repository settings need explicit authority and are not
implied by changing YAML. Existing compiler/runtime/dependency configuration stays.

### Q42 — live documentation and supersession

Owners: [live guidance](documentation-live.md), with
[ADRs](documentation-adrs.md) and [historical records](documentation-records.md).
Clarify old normative layout, public draft revision and trigger-projection
examples against accepted ADRs/current contracts. Add dated supersession pointers
where old plans or qualification summaries otherwise look current. Preserve
historical results and implementation-progress truth; do not erase failed or
limited evidence.
Acceptance: live instructions no longer require obsolete public
`expectedRevision` or synchronous runtime-trigger rebuilding; current status
links to the latest applicable evidence with dates/counts checked from artifacts;
historical records remain identifiable as historical. Run documentation tests
and link validation after every related package's documentation updates. This
package does not reopen accepted architecture or require an ADR for routine
wording/fix corrections.

## Concrete readability transformations and non-transformations

The area ledgers carry source excerpts and exact locations. These condensed
examples show the proposed reading contract, not copy-ready patches that bypass
their domain-specific guards.

### Make failure state explicit when `undefined` is a valid rejection

Q11/WQ-195 and related transaction owners must not use the error value itself
as the flag that decides whether a client is reusable:

```ts
// Insufficient state representation:
let rollbackError: unknown;
try { await rollback(); } catch (error) { rollbackError = error; }
release(rollbackError !== undefined);

// Proposed local shape; keep initiating-error aggregation in the real owner:
let rollbackFailed = false;
try { await rollback(); } catch (error) {
  rollbackFailed = true;
  recordCleanupFailure(error);
}
release(rollbackFailed);
```

The helper names above are schematic. No shared `recordCleanupFailure` API is
proposed. Acceptance is the real driver's disposal argument and preserved error
identity for `throw undefined`, ordinary errors and combined failure, not fewer
lines or fewer branches.

### Observe asynchronous work at creation, not after an unrelated await

Q40/WQ-229's waiter can reject while its owner is deliberately holding another
resource. Attach both settlement handlers immediately:

```ts
const waiterOutcome = acquire().then(
  (value) => ({ kind: 'acquired' as const, value }),
  (error: unknown) => ({ kind: 'failed' as const, error }),
);
// Perform the bounded hold; its resource still has an independent finally.
const outcome = await waiterOutcome;
if (outcome.kind === 'failed') throw outcome.error;
```

This is not permission to leave an acquired late value unclosed if the hold
fails first. The actual owner must await/clean that outcome in its failure path.
A tagged outcome makes success/failure explicit and does not lose an undefined
rejection. Test early rejection, early acquisition, hold failure and late result.

### Total predicates must reflect SQL's three-valued logic

Q10/WQ-209 replaces nullable lease inequality with explicit admission and total
comparison; Q10/WQ-206 separately repairs nullable CHECK/JSON predicates:

```sql
-- Insufficient without non-NULL admission:
IF stored_token <> supplied_token THEN ... END IF;

-- Proposed shape, retaining the actual function's locks and error contract:
IF supplied_token IS NULL OR supplied_fence IS NULL THEN
  RAISE EXCEPTION 'invalid lease' USING ERRCODE = '22023';
END IF;
IF stored_token IS DISTINCT FROM supplied_token THEN ... END IF;
```

Do not treat an unknown result as false merely because a branch visually covers
the cases. Test each nullable component individually; do not broadly rewrite
comparisons where NULL has an intentional meaning.

### Express domain decisions, not a generic condition-count rule

Q09's stop pass should be readable as ordered phases: consume persisted facts;
decide stop precedence; stop not-yet-running work; retain running work awaiting
truth; settle eligible loop ordinals; emit the next deterministic plan. The
running/ready/waiting distinctions are required complexity, not a boolean to
flatten. Its exact matrix remains in WQ-045 and PF-05.

Likewise, Q21 retains provider-specific retry states, Q33 retains two-phase
authorization around external verification, and Q11 retains separate control
append/project/purge states. Prefer an exhaustive local switch or named predicate
only when it exposes a real concept. Avoid helper-per-line fragmentation, generic
flags-heavy fixtures, callback registries and artificial maximum function sizes.

### Bound work before inspecting discarded values

Q03/WQ-020's current `Object.entries(value).slice(0, limit)` limits retained output
after reading all enumerable values. The proposed bounded traversal selects
eligible keys/descriptors first, avoids executing accessors where required, then
inspects only admitted non-secret values. Q18/Q22 similarly preflight depth/width
before recursive schemas. Acceptance tests count actual getter visits and failure
depth, not just output length. Preserve ordinary serialization and validation
precedence; a renamed helper around the same unbounded work is not a fix.

## Final implementation acceptance and handoff

For each completed slice, record which finding subitems are FIXED, TESTED,
REFACTORED or KEEP-after-gate; partial completion must remain explicit. Preserve
the ledger's test matrix even when several findings share a source change. Run
cross-package tests where authority, output schema, stop state, artifact lifetime
or database role contracts cross the package seam.

At final authorized implementation handoff: report actual build/typecheck/unit/
integration/gate results; any skipped or unavailable database, provider, container
or AWS proof; benchmark provenance and selection decisions; exact changed files;
and remaining work. Inspect the final diff and worktree. Create commits or push
only with the user's corresponding authorization, and report branch/upstream,
commit IDs, push status and remaining uncommitted work. This review itself grants
none of that implementation or external authority.

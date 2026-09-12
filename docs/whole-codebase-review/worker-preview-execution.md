# Worker preview execution review

Date: 2026-09-12. Primary reviewer fully read five inventory files below.
Two unit files / 39 tests passed. ADR-016 was reread, including its five-minute
execution deadline and seven-day retention distinction. Local probes used
injected adapters or the real in-process registry. A connection sentinel blocked
all PostgreSQL checkout attempts during adapter testing; no service was used.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/src/execution/preview-attempt-handler.ts` | FIX WQ-112/WQ-107 extension; TEST/REFACTOR WQ-113 | Keeps one logical attempt, exact preview identities, retention-scoped artifacts, bounded stored output and post-commit metrics. BeforeDispatch receives queue rather than execution signal; raw invocation can outlive handler; concurrent marker guard has same race as production. |
| `apps/worker/src/execution/preview-attempt-runtime.ts` | FIX WQ-111/WQ-079 extension; TEST/REFACTOR WQ-113 | Exact release allowlist and typed outcome classification are useful. Store adapter drops connection fence/binding; configVersion is only positive-integer parsed, never matched. Name-based error mapping and unclosed invoker tests need tighter evidence. |
| `apps/worker/src/execution/preview-attempt-supervisor.ts` | FIX WQ-112 | Distinguishes deadline, lease loss and invocation failure and observes late invocation rejection. Heartbeat runs after an abort-resolved delay without a guard; detached loop can fail outside its catch; stop/raw invocation ownership incomplete. |
| `apps/worker/test/preview-attempt-handler.test.ts` | KEEP; TEST WQ-111–WQ-113/WQ-107 | Useful deadline/transport distinction, dispatched cancellation, identity and stored-artifact evidence. Fake store proves handler forwarding, not real adapter forwarding. Duplicate marker test is sequential; lease fixture deadline one hour violates ADR-016's five-minute production maximum. |
| `apps/worker/test/preview-attempt-runtime.test.ts` | KEEP; TEST/FIX WQ-111/WQ-113 | Actual Slack/email registrations and mapping resolver are good in-process integration. No tests traverse the real database store adapter; invokers are not closed, including the JSONata-worker case. Version/release matrix incomplete. |

## WQ-111 — forward preview connection authority and provider binding

Priority P1 FIX. `preview-attempt-runtime.ts:70–88` destructures only
`{ lease, signal, workerId }` from markDispatched input. It discards
connectionFence and providerDispatchBinding supplied by
`preview-attempt-handler.ts:311–329`. The underlying database function
`packages/database/src/execution/preview-execution-dispatch.ts:18–25,65–106,108–125`
supports both: it conditionally checks current connection authority and verifies/
persists the provider binding. Because the adapter omits them, those checks
are bypassed on the actual preview path. Earlier JIT resolution/assertCurrent
does not replace this final transactional fence against intervening rotation or
revocation. This is not a request to introduce a new credential policy.

Differential local probe: direct markPreviewDispatched with an invalid supplied
connectionFence rejected with ZodError before checkout; the real worker adapter
with the same field reached the blocked connection sentinel. Repeated for an
invalid providerDispatchBinding, with the same result. Both checkout attempts
were blocked; direct calls used no real pool. Source inspection confirms valid
fields are discarded identically. Existing handler fake records the fields and
passes, explaining why its test does not catch this adapter defect.

Plan: include both optional fields when projecting the adapter input, preserving
absence versus provided value and retaining existing tenant/lease/worker parsing.
Do not weaken the database predicate or duplicate currency validation elsewhere.
Acceptance: exact adapter forwarding of both fields alone/together/absent;
malformed values rejected before checkout; real qualified transaction test for
rotation/disable winning between JIT resolve and dispatch; no provider bytes on
fence failure; mismatched existing binding cannot dispatch; identical binding
retains correct behavior. Traverse handler → real adapter → persistence for the
regression, using the existing database fixture rather than another all-success
mock. No secret, binding payload or raw credentials in test logs.

## WQ-112 — supervise actual preview work, not just the winning promise

Priority P1/P2 FIX. `preview-attempt-supervisor.ts:83–127` and
`preview-attempt-handler.ts:286–347,400–454`. Coordinate WQ-106/WQ-104.

1. After waitForSupervisorDelay resolves from abort, heartbeat is still called
   with an already-aborted signal. Immediate-stop probe at a 1,000 ms heartbeat
   interval produced one heartbeat call with signal.aborted=true. Add a post-wait
   abort guard. Actual DB rejects aborted commands before work, so this is not
   proof of a committed post-shutdown renewal, but it makes stop depend on an
   unnecessary adapter call and can stall it.
2. The detached async loop is not itself stored/observed. Only heartbeat() is
   inside try; delay or heartbeat-result interpretation errors can reject the
   detached loop without resolving heartbeatDone. Own one observed loop promise
   whose settlement always reaches stop, preserving original lease failure.
   Test invalid adapter result and rejected delay seam without unhandled rejection.
3. race observes late invocation rejection but does not drain invocation. A
   deferred invoker ignoring abort, deadline=20 ms probe returned a timed_out
   handler result while raw invocation was still active. The probe then resolved
   it explicitly. Queue drain sees the completed handler and may release its
   capability dependencies while raw work still uses them. Keep truthful durable
   deadline completion, but retain raw work under the runtime owner until it
   settles or a documented forced-close outcome is reported. Never rerun a
   timed-out unsafe invocation or silently call it drained.
4. Preview beforeDispatch uses the original queue signal, not supervisor's
   execution signal. Move environment/supervisor assembly into one protected
   ownership scope so dispatch marking receives execution cancellation, while
   durable completion retains the queue signal. Keep the explicit distinction:
   execution timeout may permit truthful terminal persistence; transport
   revocation must not create a new terminal write. Database deadline/lease
   predicates must be checked during its own review; a worker flag alone is
   not durable authority.
5. Apply WQ-107's local marking/marked guard to preview's beforeDispatch too.
   Two simultaneous callers must not both acquire permission. Preserve known
   connection/binding error mapping and do not interpret arbitrary error names
   or throwing getters as trustworthy authority.

Acceptance: stop before first tick, during tick, after heartbeat outcome; raw
invocation and raw heartbeat ignored abort, late resolve/reject; deadline versus
queue abort versus lease loss versus near-simultaneous success; no unnecessary
heartbeat after stop, no unhandled rejection, no dependency release while active
work is unaccounted for. Preserve a result that actually won before deadline,
unsafe/idempotent uncertainty and the single preview-attempt identity contract.
Do not use retention expiry for execution timeout or add another generic
supervisor framework merely to rename existing concepts.

## WQ-079 extension — worker preview must honor config-version pinning

`preview-attempt-runtime.ts:47–58,181–228` accepts any positive configVersion,
then passes config (but no version) to registry execution without comparing it
to the pinned definition. Current real core registry probe with core.set v1,
empty valid config and configVersion=999 returned succeeded/output={}. This
matches the earlier API validation discrepancy; it is not merely an impossible
typed input assumption. Resolve the exact definition under the pinned release,
validate its config version/migration policy, and reject unsupported values
before input evaluation or executor work. Keep immutable preview acceptance;
do not silently migrate stored config to current behavior or substitute a newer
executor. Add API acceptance/worker parity regression as part of WQ-079, rather
than a separate competing version policy.

## WQ-113 — preview test fidelity and localized simplification

Priority P2 TEST/REFACTOR; P3 comment correction.

- Extract one private lease-identity projection in the database adapter rather
  than separately parsing the same lease for mark/heartbeat/complete. Its
  interface must still expose each operation's own required fields; WQ-111
  demonstrates why overly aggressive projection can discard authority.
- completeOutcome repeats three await-complete-and-record paths. First derive
  a validated terminal outcome (including output-invalid and dispatched-cancel
  policy), then perform one completion call and metric projection. Keep the
  output codec, original result kind and first-commit-only telemetry. Compute
  deadlineExceededOutcome once in each branch. Do not move metrics before commit.
- Correct comment near `preview-attempt-handler.ts:169–176` claiming artifact
  composition is still future work: current capabilities/tests already support
  artifact references inside the bounded output envelope. Keep distinction
  between streaming raw values and wrapping a small artifact reference.
- Default invoker creates JsonataEvaluator before constructing release support;
  protect ownership on construction failure or build pure support first.
  Every test that creates an invoker must close it in finally, including the
  actual expression-evaluation test. Vitest worker termination is not proof of
  explicit evaluator cleanup. Add invoke-after-close and active close contract
  evidence at its actual owner rather than leaking a detached evaluator.
- Handler fixture should use a valid <=5 minute execution deadline and separate
  retention deadline. For timing tests use controlled clock and explicit start
  signals; a 40 ms wall-clock deadline is vulnerable to loaded CI. Preserve the
  real timer scenario only when it measures a specific runtime contract.
- Replace delivery cast-as-never with a complete valid queue transport fixture
  including attemptsMade. Keep opaque random UUIDs where uniqueness matters,
  deterministic IDs where assertions benefit; neither is universally superior.
- Exact handler input identity/checksum, wrong workspace/attempt/fence, no-op
  duplicates, complete rejection and duplicate completion no telemetry. Test
  success with connectionRefs present and both metric callbacks failing. Add
  bounded invalid outputs and actual artifact retention path, not fake only.
- Invoker: wrong node ID, definition version, executor pair, config version,
  unsupported release fingerprint, input-artifact refusal, safe/unsafe/idempotent
  outcome matrix and canceled mapping. Real registry fixtures must validate
  exact pins. Existing safe core fixture with synthetic unsafe flag is a
  classification unit test, not a realistic persisted unsafe node.
- Error mapping: stable known durable errors versus arbitrary same-name errors,
  hostile rejection/getters and bounded messages. Preserve ordinary failure
  identity under WQ-030. Prefer actual error contracts/shared safe codes to
  reflecting arbitrary error.message into unrecoverable queue text.
- ADR-016 permits exactly one preview attempt and rejects Wait suspension;
  keep these intentional limitations. Reuse production input resolver/value
  policy, but don't merge preview with the production workflow state machine.

Order: WQ-111 authority loss first, WQ-112 ownership and WQ-079 pinning with
their regressions next, then evidence and optional expression cleanup. Review
only: no implementation, SQL mutation, commit, push or provider call occurred.

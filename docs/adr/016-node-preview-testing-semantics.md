# ADR 016: Node preview and testing semantics

- **Status:** accepted
- **Date:** 2026-08-22

## Context

Draft validation and a real provider test have materially different safety
properties. Treating both as a generic "test" would either make validation
surprisingly side-effecting or imply a dry-run guarantee that many providers do
not offer. A preview also cannot borrow production workflow state: it is based
on a mutable draft, may use credentials, has shorter retention, and must remain
truthful across duplicate delivery or a worker crash.

## Decision

### Two explicit modes

The node-test contract is a discriminated union with exactly two modes:

- `validate` pins an expected draft revision and parses the selected node's
  definition, configuration, mappings, connection references, resolved sample
  input, and input/output schemas. It performs no credential decryption, DNS
  lookup, provider request, queue dispatch, or external side effect.
- `test_execute` pins the same draft revision and exact compatibility release,
  then executes one selected node in the worker using either bounded manual
  input or the successful bounded output of an unexpired prior preview in the
  same workspace and workflow. It may perform a real external side effect.

Validation returns bounded field-addressed issues plus a side-effect disclosure
derived from the pinned definition. It never claims that a provider request
would succeed. A side-effecting `test_execute` request must carry an explicit
acknowledgement and an `Idempotency-Key`; omission is a stable client error.
Provider-specific dry-run behavior is allowed only when the exact pinned
executor declares it as a capability. The platform never infers or promises a
universal dry run.

### Durable preview identity and isolation

An accepted `test_execute` command creates one immutable **Preview run** and one
logical preview node attempt. The durable record pins workspace, workflow,
draft revision and fingerprint, node and definition identity, compatibility
release, actor, bounded input reference, disclosure, request-idempotency claim,
retention deadline, and trace context. Jobs contain only those identifiers.
The API returns `202 Accepted` with the preview identity and a status resource;
it does not execute the node or hold the request open for provider completion.

Preview state is separate from production workflow runs and checkpoints. A
preview does not publish or mutate a workflow version, advance production
graph state, update trigger cursors or subscriptions, emit production run SSE,
or become reusable production input. A prior preview can supply test input only
through its explicit, same-workspace, same-workflow, successful, unexpired
reference. Preview records are short-retained and remain visible to scoped
audit and usage queries until expiry.

### Execution truth and bounded values

The worker resolves authorized credentials just in time and executes the exact
pinned executor through the normal node-execution seam. ADR 007 governs the
side-effect class, pre-dispatch marker, stable provider idempotency key, lease
fencing, timeout/abort behavior, duplicate delivery, retry eligibility, and
ambiguous outcomes. Preview attempts therefore use the same terminal truth as
production attempts, including `outcome_unknown`; a timeout is not silently
reported as a definite failure when an unsafe provider may have accepted the
request. A request retry returns the same preview and does not create another
provider call.

Manual input, resolved input, output, errors, events, and responses use the
same bounded JSON and artifact-reference rules as production execution. Large
or unsuitable values stream to workspace-scoped object storage; queue messages,
logs, audit facts, metrics, and public problems contain neither value bodies nor
credentials. Preview artifacts inherit the preview retention deadline and may
not outlive their owning preview.

### Authorization and observability

Both modes require workflow read/build authority for the selected draft.
Connection use is authorized independently for every referenced connection;
the worker rechecks workspace ownership and usability before decryption. Every
accepted execution, credential access, terminal outcome, and side-effect
disclosure is audited with safe metadata. Traces connect API acceptance,
outbox/queue delivery, credential resolution, provider dispatch, and terminal
persistence. Metrics classify provider, operation, connection, outcome,
timeout, retry, and preview usage without high-cardinality secret or URL data.

## Consequences

Callers must choose between a cheap read-only report and a truthful durable
execution, so product copy can disclose risk before a real effect. The worker
and persistence model are slightly larger than a synchronous test helper, but
preview crash and duplicate behavior no longer depends on an API process or on
optimistic assumptions about provider outcomes.

The preview path deliberately reuses execution policies and bounded-value
modules while keeping production scheduler state separate. Any future
multi-node preview or reusable preview fixture requires a new explicit product
contract rather than widening this single-node mode implicitly.

## Rejected alternatives

- One ambiguous test endpoint that may or may not contact a provider.
- Executing provider tests inside the API process.
- Treating every provider as if it supported a safe dry run.
- Reusing production runs, checkpoints, trigger state, or published versions
  for mutable-draft previews.
- Returning full provider bodies or credential-bearing errors for debugging.

## Amendment: separate execution deadline and identity convention

Accepted 2026-08-28.

Preview execution and preview retention are independent policies. Acceptance
pins an immutable `execution_deadline_at` no more than five minutes after
acceptance and a separate `expires_at` retention deadline no more than seven
days after acceptance. The execution deadline must be after `created_at` and
must not exceed retention expiry. Claim, heartbeat, worker timeout, and
reconciliation use only `execution_deadline_at` to decide execution truth.
Status reads, prior-preview eligibility, cleanup discovery, and preview-owned
artifact lifetime continue to use `expires_at`. An artifact may therefore
remain available for the retained preview after execution has terminated, but
it may never outlive that preview.

V1 preview identity is also fixed explicitly. A preview contains one logical
attempt, so its executor-facing `attemptNumber` is always `1`.
`invocationKey` is `preview:<nodeId>`; `runId` and `nodeRunId` both use
the preview-run UUID; and `attemptId` uses the preview-attempt UUID. These
values adapt the single-node preview to the existing executor and capability
contracts only. They do not create production workflow-run, node-run, or
checkpoint identity, and any future multi-node or retrying preview requires a
new ADR and persisted identity model.

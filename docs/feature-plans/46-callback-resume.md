# F46 — Resume a Wait through a callback

Status: **Implemented (owner approval: 2026-10-21).**

## Outcome

Wait gains **Until called back** alongside the existing duration mode. An earlier
step can send a URL for this run and this Wait to another system. A successful
POST resumes the original run once, using the existing durable pending-task
mechanism. Follow [n8n Wait](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait/),
with the owner's stricter per-Wait identity and hash-only token storage.

## Approved design decision (2026-10-21)

Current mappings are ordinary JSON, and ADR 052 records their resolved values
before execution. Existing pending tasks require an already completed step and
cannot receive a response before it opens. Putting a resume URL in a normal
step output would store a credential; opening the task only when Wait executes
would lose fast callbacks. An in-memory latch would fail across workers/restarts.

Approved: extend the **existing runtime mapping context**, **existing pending-task
format** and [ADR 076](../adr/076-durable-human-tasks.md), rather than introduce
another resume subsystem:

- Add a bounded execution binding to the existing JSONata mapping context, keyed
  by Wait identity and selecting its URL or authentication secret in the same
  structured scope. The normal picker inserts an existing expression mapping;
  label/value object rows keep their existing JSONata serialization. A worker
  capability supplies the credential just before resolution. The stored graph
  keeps the expression reference, with one evaluator and no browser-issued token.
- Permit a prepared callback task without a physical node-run binding. It retains
  a stable logical identity (run, Wait and iteration scope), token hash, derivation
  key version and bounded optional response. Bind it to the exact invocation when
  Wait opens. A prepared response settles through the same task-result/checkpoint
  transaction as an ordinary response. No second resume queue or scanner.
- Use a purpose-specific versioned application key to reproduce an unguessable
  256-bit token after restart. Keep only its hash in PostgreSQL; store no plaintext
  token or encrypted equivalent. Follow the invitation-token key pattern exactly:
  `CALLBACK_TOKEN_KEY`, `CALLBACK_TOKEN_KEY_VERSION` and
  `CALLBACK_TOKEN_PREVIOUS_KEYS`, using the same generator, startup refusal and
  separately supplied backup-key instructions. Retain previous versions while
  live callback tasks still need them; refuse missing or incorrect keys at startup.
  Require the key/version pair when deployed and refuse the public development
  key, including in previous-key entries. API and worker each verify retained
  hashes independently; no API-waits-for-worker ordering is introduced.

The owner explicitly approved the runtime mapping binding, prepared callback task
inside the existing pending-task owner, ADR 076 amendment and hash-only token
storage on 2026-10-21. The mapping keeps the existing stored expression format.

## Rules

- Old duration-only Wait configuration and execution stay unchanged. Callback
  timeout is required, 1 second–30 days. Start the timeout when Wait opens; the
  existing absolute run deadline can end it earlier. Before opening, the callback
  remains valid only while its original run is live and can still reach that Wait.
- Different Wait steps and loop iterations have different credentials; retries
  reuse the same identity. Mapping targets must be enabled callback Waits in the
  same containing graph/iteration scope. Publication rejects missing or ambiguous
  targets. New replay runs get fresh identities; recovery retains its existing
  restrictions on control steps. Whole-workflow draft tests issue live callback
  URLs and pause at an unpinned callback Wait, so the editor can test an actual
  callback end to end. Existing draft-test effects acknowledgement, capacity,
  retention, history and notification exclusions remain. Single-step previews
  never issue live callback URLs. Duration Waits still complete immediately in
  draft tests; pins still replace a pinned step's execution.
- Default authentication is Secret URL. Optionally choose Signed or Header secret,
  reusing [webhook authentication](webhook-authentication.md): exact raw-byte HMAC,
  timestamp window, constant-time header comparison and the shared header-name
  rules. A separate derived signing/header secret can be mapped to the sender.
  There is no provider-specific signature or new credential scheme. A mode change
  affects new runs only; accepted runs keep their immutable configuration.
- Accept POST only through `/hooks/…`, under the current private Caddy route and
  URI redaction. No GET/link-preview side effects. Use the existing webhook JSON
  body and retained-value bounds, safe-header projection, native ingress limits
  and non-disclosing authentication failure. Return 202 for the first accepted
  response, 409 for an already accepted response, and 410 for an expired/canceled/
  completed run. Concurrent callers race under the existing run/task locks; one
  wins. Authentication is checked before disclosing task state.
- Save accepted body and safe headers as the Wait result; no authorization,
  cookies, signatures or credential headers. Preserve size/depth/member limits;
  refuse oversized input before saving anything. A callback accepted before Wait
  opens is durable but cannot run downstream steps until the workflow reaches it.
- Reuse the pending-task capacity allowance, due scanner, wakeup/ancestor path,
  paused clock, active-slot release/reacquisition and single-consumption logic.
  Prepared and answered-but-not-yet-bound tasks count toward the allowance. A run
  ending or skipping the target closes its unused task. Retention and workspace
  purge remove credentials and responses with the run; callbacks are not human
  tasks and never appear in the approvals list or request a human decider.
- Treat materialized URLs and secrets as credentials throughout execution. Do
  not record them in attempt inputs, returned outputs, files, diagnostics, logs
  or traces. Reuse known-secret response redaction at provider boundaries. Prove
  the supported delivery path and echo behavior before claiming hash-only storage;
  do not add a general taint engine to make unsupported transformations work.
  Only static binding leaves, including the existing picker’s parenthesized
  object/array values, are supported. Copies remap a copied Wait’s references.
  At most 16 Waits can be prepared per sender; transport redaction allows 64
  known values (32 existing credential values plus two per callback).
- Show the Wait mode, timeout, authentication choice and mapping reference with
  normal editor controls. Run history records the first callback and the timeout
  outcome without request credentials. No manual copy of a live run secret from
  history, browser-only callback server, public form or extra service.

## Ownership and delivery

One implementation PR after this approved plan merges; moves remain separate commits.

| Existing owner | Change |
| --- | --- |
| `workflow-model/mapping`, pending-task contracts | Reference validation, shared Wait setup and result; one mapping resolver |
| `node-sdk`, `nodes-core/flow/wait`, `workflow-engine` | Scoped capability, callback declaration, existing task observations |
| `database/schema/runs`, `runs/pending-tasks` | Prepared/bound callback state, hash lookup, atomic response/consumption, retention |
| `integrations/webhooks`, application keys | Existing authentication and purpose-specific token derivation |
| `worker/attempts`, API webhook ingress | Lease-scoped issue, credential-safe capture, bounded authenticated POST |
| `web/workflow-editor`, run detail | Normal mapping/setup controls and safe waiting/completion display |
| deployment examples, secret generator, recovery guide | Key generation, previous versions, startup and restore checks |

Qualification: unit bounds and target/scope validation; populated migration and
forced RLS; real API/worker POST before/after Wait, concurrent duplicate, restart,
retry, whole-workflow draft-test callbacks, single-step preview refusal,
wrong-workspace/scope, cancellation, timeout and failure route; nested and
parallel/Call capacity and clock behavior; all three authentication modes; body,
header and credential non-retention; retention/purge/restore with right/wrong key;
real editor journey and desktop/pane/phone in both themes. Full unskipped hook and
green existing CI before rebase merge. Update only this status and the F46 roadmap
row on delivery.

Qualification also covers inherited Condition selections inside a parallel branch.
The shared scheduler now retains those selections in their existing iteration
scope, so skipped callback targets close through ordinary coordinator settlement.
Merge waits for its selected source to materialize before recording an immutable
arrival; an intermediate ancestor cannot settle it without the final result.

The approval notice observer takes its run fence before its task fence, matching
decisions and coordinator settlement. A deterministic PostgreSQL regression covers
the deadlock found by the existing live approvals journey during qualification.

# F46 — Resume a Wait through a callback

Status: **Plan ready; owner decision required on the format extensions below.**

## Outcome

Wait gains **Until called back** alongside the existing duration mode. An earlier
step can send a URL for this run and this Wait to another system. A successful
POST resumes the original run once, using the existing durable pending-task
mechanism. Follow [n8n Wait](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait/),
with the owner's stricter per-Wait identity and hash-only token storage.

## Required decision before code

Current mappings are ordinary JSON, and ADR 052 records their resolved values
before execution. Existing pending tasks require an already completed step and
cannot receive a response before it opens. Putting a resume URL in a normal
step output would store a credential; opening the task only when Wait executes
would lose fast callbacks. An in-memory latch would fail across workers/restarts.

Recommended: extend the **existing runtime mapping context**, **existing pending-task
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
  token or encrypted equivalent. Reuse the current key/version/previous-keys
  configuration pattern, startup refusal and separately supplied backup keys.

The prepared-task format extension and ADR amendment are absent from the original
scope; the mapping uses the existing stored expression format. AGENTS.md reserves them for the owner; implementation is paused until
approved. This plan does not silently authorize them.

## Rules after approval

- Old duration-only Wait configuration and execution stay unchanged. Callback
  timeout is required, 1 second–30 days. Start the timeout when Wait opens; the
  existing absolute run deadline can end it earlier. Before opening, the callback
  remains valid only while its original run is live and can still reach that Wait.
- Different Wait steps and loop iterations have different credentials; retries
  reuse the same identity. Mapping targets must be enabled callback Waits in the
  same containing graph/iteration scope. Publication rejects missing or ambiguous
  targets. New replay runs get fresh identities; recovery retains its existing
  restrictions on control steps. No live credential is issued for previews or
  draft tests; tests must pin the sending step if it needs a callback URL, while
  Wait keeps the existing immediate-test behavior.
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
- Show the Wait mode, timeout, authentication choice and mapping reference with
  normal editor controls. Run history records the first callback and the timeout
  outcome without request credentials. No manual copy of a live run secret from
  history, browser-only callback server, public form or extra service.

## Ownership and delivery

One implementation PR after the format decision; moves remain separate commits.

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
retry, wrong-workspace/scope, cancellation, timeout and failure route; nested and
parallel/Call capacity and clock behavior; all three authentication modes; body,
header and credential non-retention; retention/purge/restore with right/wrong key;
real editor journey and desktop/pane/phone in both themes. Full unskipped hook and
green existing CI before rebase merge. Update only this status and the F46 roadmap
row on delivery.

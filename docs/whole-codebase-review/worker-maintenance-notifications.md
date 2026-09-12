# Worker maintenance and failure notifications review

Date: 2026-09-12. Primary reviewer fully read all ten inventory files below.
Four unit files / 53 tests passed. Probes used injected stores/provider fakes
only; no database, Redis, KMS, Slack or email service was contacted.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/src/execution/failure-notification-delivery.ts` | KEEP policy; TEST/REFACTOR WQ-105; WQ-028/WQ-030 integration | Destination identity, immutable context, final durable fence, email binding and secret-byte clearing are real responsibilities. Slack unsafe ambiguity and email idempotent retry must remain different. Long result switches describe actual policy, not arbitrary condition excess. |
| `apps/worker/src/execution/failure-notification-handler.ts` | TEST/CONDITIONAL WQ-104; KEEP durable authority | Claims checksum-bound intent, carries queue abort through claim/completion, removes listener and timer, validates delivery result and conservatively maps unknown failures. Timeout only requests cancellation; injected delivery can remain pending. |
| `apps/worker/src/execution/operator-run-replay-runtime.ts` | KEEP modes; TEST/REFACTOR WQ-105 | Resolves retained admission/current release for new replay, uses worker checkpoint factory, distinguishes non-executable from durable mismatch, and persists command failure before unrecoverable acknowledgement. Do not mark failed when the persistence write itself failed. |
| `apps/worker/src/execution/preview-maintenance-runtime.ts` | FIX WQ-102 extension; TEST/REFACTOR WQ-105 | Explicit capability flags gate stores and handlers. Startup-before-try and eager closer issues recur; cached close and bounded recovery-loop helper are useful. Recovery loop wakes even when notifications are disabled. |
| `apps/worker/src/execution/preview-reconciliation-runtime.ts` | KEEP; TEST WQ-105/WQ-030 | Thin store adapter owns a real pool lease; handler forwards exact fence/checksum and preserves committed result despite telemetry failure. Default telemetry construction can throw before caller rollback scope. |
| `apps/worker/src/execution/unknown-outcome-reconciliation-runtime.ts` | KEEP; TEST WQ-105/WQ-030 | Narrow evidence-identity adapter preserves tenant and signal. Four permanent error categories are an understandable policy list; classification must not replace a hostile original rejection. |
| `apps/worker/test/failure-notification-delivery.test.ts` | FIX/TEST WQ-105 | Broad provider/fence/credential/history matrix is valuable. Two-call email ambiguity test reuses wiped credential bytes, so second provider outcome is not actually exercised. Several stubs never call beforeDispatch and some assertions check only kind. |
| `apps/worker/test/failure-notification-handler.test.ts` | KEEP; TEST WQ-104/WQ-105 | Tests cancellation during claim and completion, inert terminal duplicates and cooperating timeout. Missing ignored-abort/late settlement, invalid result, busy claim and listener cleanup scenarios. |
| `apps/worker/test/preview-reconciliation-runtime.test.ts` | KEEP; TEST WQ-102/WQ-105 | Exact checksum/fence and post-commit metrics, cached close, bounded recovery failure are useful. Add enabled-job routing matrix, actual pending repeated close, sync closer/partial acquisition and late recovery settlement. |
| `apps/worker/test/unknown-outcome-reconciliation-runtime.test.ts` | KEEP limited forwarding proof; TEST WQ-105 | One exact identity/signal mapping test is sound but does not prove error mapping or persistence authority. Extend those at their respective interfaces, not via a larger fake repository. |

## WQ-102 extension — maintenance owns optional stores and the recovery loop

`preview-maintenance-runtime.ts:82–140,188–231` repeats the coordinator owner
gap: multiple acquisitions and default telemetry construction precede try;
startup cleanup and normal close eagerly invoke closers before allSettled.
Apply WQ-102's protected acquisitions, deferred independent closes, cached
result and full error preservation here, coordinated with the transport
provider's dependency drain order in WQ-096. Existing bounded recovery timeout
must not be removed. Observe and settle raw recovery work; a timeout is not
proof no work is using the store. Add a late-settlement test to the existing
never-settling fake test. Avoid running a one-second empty recovery loop when
no failureNotificationStore exists, keeping disabled capability resource-free.
The comment that readiness remains fail-closed is not evidence that repeated
recoverDue failure is actually visible to readiness; integrate health evidence
with the existing worker owner, as in WQ-102.

## WQ-104 — distinguish a delivery deadline from a cancellation request

Priority P2 TEST/CONDITIONAL. `failure-notification-handler.ts:80–112` starts
a timer that aborts a controller but then directly awaits deliver. Local probe
used timeoutMillis=5 and a deferred delivery ignoring signal: at 30 ms the
signal was aborted, handler was still pending, completeDelivery calls=0.
Releasing the fake delivered result allowed normal completion. This proves
cancellation-only behavior, not a production provider outage or an incorrect
durable terminal status.

Before implementation, pin the intended capability contract: either every
production delivery stage must settle within a documented bound after abort,
with the queue/runtime owner enforcing that contract, or the handler must own
a bounded settlement protocol. Audit destination loading, decryption, provider
dispatch, response and completion separately. Existing production stores and
secure HTTP already implement cancellation mechanisms; test them before adding
another timeout layer. Do not race work, call it canceled, and immediately retry
an unsafe delivery that might still send bytes. Durable dispatch fences,
attempt number, unresolved history and recovery authority must remain decisive.

Acceptance: abort before claim, during claim, destination/decryption/fence/
provider work, after provider success and during completion; exactly one
terminal write attempt with original queue signal; ignored abort cannot hold
the owning runtime forever; late resolve/reject is observed and cannot cause
duplicate dispatch or overwrite a newer durable attempt. Validate timeout and
retry bounds at the actual configurable composition seam. If runtime/adapter
ownership already guarantees the bound, KEEP the signal-only handler and
document/test that contract; do not add an unnecessary shared deadline module.

## WQ-105 — preserve provider policy while making tests and branches legible

Priority P2 TEST/FIX tests; P3 REFACTOR. Main locations:
`failure-notification-delivery.ts:32–79,83–232,263–506`, its test at
`:492–554`, maintenance routing `:146–185`, reconciliation mapping functions,
and operator replay `:77–136`.

### Test fidelity and concrete regressions

The email persisted-ambiguity test uses:

```ts
open: vi.fn().mockResolvedValue(encodedCredentialBytes)
// deliver twice; production finally zeroes the returned bytes.
```

A matching current-source probe reached the provider only once across two
deliveries; second result was outcome_unknown from invalid credentials and
history preservation. The assertion on kind/possiblyDispatched still passes.
Use a fresh Uint8Array from each open call. Assert provider invocation twice,
the selected second result is actually consumed, and the exact output policy.
Keep each returned byte buffer and assert it is zeroed after each success/error.
This is a test defect, not a reason to stop wiping secrets.

- Separate pure-result adapter tests from dispatch-fence tests. For the latter,
  provider fake must call and await beforeDispatch before recording bytes.
  Assert fence failure sends zero bytes. Keep the existing tests that already
  do so; do not claim all provider stubs model dispatch correctly.
- Email binding test currently checks only a hash-shaped string. Assert exact
  stable binding across identical requests, changed binding for each bound
  field, and persisted fence refusal for changed identity after ambiguity.
  Keep the stable idempotency key, pinned secret version and bounded rendering.
- Preserve current history rules with fresh credentials: initial/previously
  unresolved × success/definite refusal/429/5xx/invalid response/KMS/identity/
  destination failure. Do not infer history from deliveryBinding presence.
- Extend WQ-028 with notification delivery through the actual Resend client:
  malformed bodies at refusal statuses must retain status truth. Initial
  definite refusal differs from unresolved historical delivery. This shares
  the existing client fix, not a new notification-specific parser.
- Unknown/hostile rejected values in localFailure, destination catch and
  reconciliation/replay mappers must not be coerced or replaced by instanceof
  inspection failure (WQ-030). Handler's catch-all conservative fallback remains
  intentionally safe; do not expose raw credential/provider messages.
- Handler: busy claim, already-aborted queue, claim/complete rejection, malformed
  or extra-field result, delivered result after timeout, exact identity/checksum
  and listener/timer teardown. Current objectContaining assertions are not proof
  all immutable fields were forwarded.
- Preview reconciliation: duplicate/rescheduled/no-terminal and completed with
  optional labels absent; first/second metric callback throws and original
  result remains; every mapped permanent error and ordinary rejection identity.
- Unknown/replay: actual exported handler mapping for every known error, successful
  forwarding, non-executable fail-write success/rejection, no fail call for
  mismatched identity or transient outage. Add default release-history/current
  selection and invalid projection evidence at qualified database integration.
- Maintenance routing: every enabled/disabled job; unrelated queue job; all
  optional stores remain unconstructed when disabled; recovery only when needed.
  Startup failure at telemetry/trace/consumer and each optional owner; sync and
  asynchronous close failures; pending concurrent close and late raw work.

### Readability plan and KEEP decisions

Keep result switches for Slack and email separate: identical-looking HTTP
statuses deliberately map differently because Slack is unsafe and email has a
stable idempotency key. Keep settleUnresolvedDelivery as the single named email
history-preservation step. Do not add that step indiscriminately to Slack
provider responses: production unsafe prior dispatch is terminalized by durable
claim/completion/recovery policy. A synthetic impossible history flag is not
proof of duplicate production Slack dispatch; verify the database invariant.

Group notification implementation by pure rendering/classification, credential
ownership and provider invocation; remove redundant `as const` only where the
declared return type already supplies the same discrimination. Small helpers
for repeated result shapes are worthwhile only if call sites retain kind,
safeErrorCode and dispatch meaning; no generic provider strategy registry.
Consider a small typed credential decode helper only if it owns meaningful
validation/zeroization without hiding provider-specific history semantics.

Maintenance's four ordered job branches are understandable. An exhaustive
switch with per-case capability guard may improve scanning, but keep the
different error-mapping contracts visible and disabled-job errors exact.
Do not introduce a dynamic handler table solely to shorten this file.
Operator replay initial checkpoint shares WQ-103's parity work, while remaining
new admission rather than already-admitted coordinator execution.

Order: owner safety and test fidelity first; establish cancellation contract
and actual adapter evidence before WQ-104 changes; fix shared client/error
seams in their existing packages; then optional local readability edits.

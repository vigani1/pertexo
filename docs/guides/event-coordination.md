# Coordinate trigger events

Open a Webhook or Form step's **Setup → Event coordination**. Choose one policy
and a key, then publish. **Off** is the default. Coordination groups business
events before run admission; it does not change workflow steps or retry effects.

Use **Run input** for a path, such as `$.orderId` for a webhook or
`$.values.orderId` for a form field. **Expression** uses the normal restricted
JSONata evaluator over `runInput`, for example `$lowercase(runInput.customerId)`.
It cannot read earlier steps or workspace variables. Keys are case-sensitive,
nonempty text up to 512 UTF-8 bytes, finite numbers or true/false. A number `42`
and text `"42"` are different keys. Only their hashes are stored as keys; pending
business input may itself contain the original field. Missing, null, object,
array or oversized keys produce a visible **Not started** event.

## Choose a policy

| Policy | Behavior | Settings |
| --- | --- | --- |
| Deduplicate | Admit the first event with a key; skip later matches without extending the window | Default 24 hours; 1 second–7 days |
| Debounce | After the key has been quiet, admit one run with its latest complete input | Default 5 seconds; 1 second–1 hour |
| Throttle | Admit at most N runs for a key in a fixed window; skip excess or delay it in arrival order | Default 1 run/60 seconds; 1–1,000 runs, 1 second–24 hours |

For an order-status webhook, deduplicate by order ID to accept it once per day.
For a burst of edits, debounce by record ID for 10 seconds to process its latest
state. To limit a customer to 5 workflow admissions per minute, throttle by
customer ID with a 60-second window and choose **Delay**. Fixed windows can allow
bursts at their boundaries. They limit run admissions, not when a queued HTTP
step reaches an external service.

Policies are independent per workspace, workflow and trigger step. Reusing a key
in another workflow does not suppress it. The same policy keeps its window across
publication; changing its settings starts a new key namespace. Pending events
pin their publication: publishing a different version refuses them visibly.

## Receipts and history

Immediate run admission keeps its normal response. Otherwise a webhook replies
202 with a receipt such as:

```json
{
  "coordinated": true,
  "eventId": "<event ID>",
  "outcome": "debounced",
  "status": "pending",
  "reason": null
}
```

Other outcomes are `deduplicated`, `throttled` and `refused`. A pending receipt
means Pertexo accepted the event for later, not that a run has started. Deferred
webhooks always acknowledge asynchronously, even with **When the workflow
responds** enabled. A later Respond to webhook step cannot send a second response.
A caller disconnect does not cancel pending work.

Exact transport retries return their original receipt and do not create another
event or extend a quiet period. Webhook transport replay runs first: a repeated
`Idempotency-Key` returns the first delivery's result without reaching
coordination. Without a key every delivery reaches it, even with identical bytes.
If identical payloads represent distinct events, give each event a
new idempotency key and reuse it only for that event's retries.

**Triggers → Recent deliveries** shows current coordination status alongside the
original HTTP admission. Form editors see **Coordinated form events** in the Form
step. Refresh to follow Pending, Started, Replaced, Skipped or Not started entries.
History includes the version, due time, safe reason and admitted run link; it never
includes input, the key or its expression. Forms show a pending/duplicate/refusal
receipt instead of their ordinary success message or redirect. Public form
receipts expose no run history.

**Usage** counts each coordinated business event once, separately from run totals
and concurrency skips. An event may start a run or be replaced, delayed or skipped;
these counts must not be added together as a run total. History and usage remain
for 90 days. Pending input is cleared immediately when it starts or stops pending.

## Bounds and capacity

A workspace may hold 10,000 active key windows and 1,000 pending events, with
64 MiB of pending input. Existing webhook/form input and ingress rate limits
still apply. A refused debounce replacement leaves its previous pending input
intact. A debounce burst or delayed event expires after 24 hours. A full run queue
at release can defer admission for up to 15 minutes, within that lifetime; it then
shows **Not started: the workspace run queue is full**. Queued throttle events
recheck the window when admitted and cannot overtake earlier events with that key.

Workflow concurrency applies at actual admission. **Skip** can skip a pending
event then; **Queue** keeps the ordinary capacity behavior. Pausing/archiving the
workflow, disabling its webhook endpoint, changing its publication or deactivating
the workspace refuses pending work. Public form link changes affect future
submissions and do not revoke accepted pending work. Restarts preserve pending
state; two workers cannot admit the same pending event twice. Cleanup may lag
while the worker is stopped, as with other retention work.

Manual/API/Call starts, draft tests, previews and suites do not use ingress
coordination. Combining policies and an in-workflow deduplicate step remain later.

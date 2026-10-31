# F25 — Trigger event coordination

Status: Deduplicate, Debounce and Throttle implemented; locally qualified
2026-10-17. Plan reconciled against main after
F29 #331, F12 #332, F02 #333 and F14 #334. [Roadmap](../product-roadmap.md).
Decision: [ADR 084](../adr/084-durable-trigger-event-coordination.md).

## Current foundations and ownership

Webhooks use database/triggers/webhooks for authenticated delivery, transport
replay and atomic admission; forms use triggers/forms and ordinary run acceptance.
Forms have no materialized workflow_triggers row. Their stable identity is the
workflow and root node. The worker already polls its trigger scanner. PostgreSQL
owns durable state, RLS, transactions and admission; Redis is delivery only.

| Owner | Responsibility |
| --- | --- |
| workflow-model/event-coordination | Shared settings, event-only key rules and pure window decisions |
| workflow-model/mapping | Shared path/expression contracts and existing resolution, grouped without behavior changes |
| nodes-core/triggers/webhook; workflow-model/forms | Optional published coordination settings |
| database/triggers/coordination | Key windows, bounded pending events, history, atomic run admission and due scans |
| schema/event-coordination | Two shared workspace-scoped physical tables and queue-discovery fence |
| database/triggers/webhooks and forms | Existing auth/replay checks, prepared event input and shared coordination call |
| worker/triggers | Run the due scan in the existing trigger runtime and lifecycle |
| api/webhooks and forms | Existing routes, 202 outcomes and authorized metadata history |
| web/editor and workflow-settings | Normal key mapping controls, settings and metadata history |
| lifecycle; usage | Payload removal, bounded expiry/purge and immutable usage facts |

No service, role, package, queue or CI job is added. Use the existing bounded
JSONata evaluator, not evaluation on the API event loop. Prepare keys before
acquiring admission/state locks, then recheck the exact version and current
authority in the acceptance transaction. Evaluator owners close with their store.

## Decisions

- Off by default. One mutually exclusive policy per webhook/Form trigger:
  Deduplicate, Debounce or Throttle. This implements all three requested modes;
  composing several policies and a workflow deduplicate step remain later.
  Settings are part of the saved/published trigger config, not a mutable override.
- A key is the normal run-input path mapping or a JSONata expression over the
  event. Webhook input is its JSON payload; Form input is values/submittedBy/
  submittedAt, so a form field uses `$.values.orderId`. There are no earlier
  steps and no workspace-variable dependency in a coordination key. A constant
  expression can intentionally group every event together.
- Keys are case-sensitive typed text/finite number/boolean, never null, arrays
  or objects. Text must be nonempty and fit 512 UTF-8 bytes. Canonicalize and
  SHA-256 hash; store only the hash as the coordination key. No raw key or input
  in logs/history/usage. Pending input follows existing bounded run-value storage.
- Scope is workspace/workflow/node/policy fingerprint/key hash. A policy change
  starts a new namespace; unchanged policies keep their window across publication.
  Database processing time owns all windows, never a sender timestamp.
- Deduplicate: fixed window from the first admitted event, default 24 hours,
  1 second–7 days. Later business-key matches are suppressed without extending
  that window. Existing transport replay happens first and keeps its behavior;
  an exact transport retry is not a new business event or usage fact.
- Debounce: trailing edge, latest complete input wins, default 5 seconds,
  1 second–1 hour. A new event replaces the pending input and postpones its due
  time; old history says coalesced. One burst may wait at most 24 hours from its
  first event, preventing indefinite retention. Expiry is a visible refusal.
- Throttle: fixed processing-time windows, default 1 run/minute; N is 1–1,000,
  window 1 second–24 hours. At the limit, choose Skip (default) or Delay.
  Delayed events keep FIFO order per key and wait at most 24 hours. Tokens are
  charged only when a run actually starts, including delayed admission; capacity
  deferral cannot release a burst above the throttle limit. New arrivals cannot
  overtake a pending delayed event. No global ordering promise across keys.
- Bound active windows to 10,000/workspace, pending events to 1,000/workspace and
  64 MiB of stored input. Existing per-event input and ingress rate bounds stay.
  Replacing a debounce event charges the net input; a refused replacement keeps
  the prior accepted pending event. These fixed safety bounds are not billing
  or a new configurable capacity subsystem.
- One event row owns pending input and its later metadata history. Clear input
  immediately on start, coalescing, skip or refusal. Keep metadata and usage for
  90 days, matching trigger delivery/run-summary history. Expired key windows
  can be removed without retaining input or breaking history. Read expiry is
  enforced even before bounded maintenance deletes rows.

## Admission, races and lifecycle

- Auth, CORS, transport replay, public-form grants, form validation and ordinary
  rate limits remain before coordination. Exact request retries return the
  original receipt and never create another event or extend debounce.
- After the existing workspace admission fence, acquire one transaction-scoped
  workspace coordination advisory lock before publication/state locks. The
  existing fence is shared, so this serializes first-key creation and bounded
  pending budgets. Atomically decide the key window,
  event, usage and either the normal run/checkpoint/outbox or durable pending
  state. Worker scanners use the same acceptance owner. Pending row locking and
  stable event-based run idempotency prevent two scanners or a restart from
  starting a debounce/delayed event twice. No external effect happens here.
- A narrow SECURITY DEFINER due-discovery function returns bounded event and
  workspace identities only, like existing schedule discovery. Real processing
  runs through workspace RLS. Use the existing trigger polling interval, one
  eligible head per key and bounded workspace-fair batches; no new job or timer
  process. The database scan remains authoritative after restart.
- F29 concurrency applies at actual run admission. Its Skip result is visible
  as concurrency_limit; Queue keeps ordinary admission. Calls/manual/API starts
  never use coordination. Test runs/previews/suites bypass ingress coordination.
- If the ordinary queue is full at release, keep pending for up to 15 minutes
  from the first due admission attempt, rechecking capacity without consuming a
  throttle token. Then refuse visibly. This is bounded by the earlier of that deadline and the 24-hour event
  lifetime. A caller disconnect never cancels an accepted pending event.
- Recheck active workspace/workflow, unpaused trigger and the pinned publication
  before release. A changed publication, disabled webhook endpoint, removed
  trigger, archive or inactive workspace refuses pending work with a safe reason.
  Already admitted runs keep ordinary semantics. Changing a public Form link
  affects future submissions; it does not revoke an already accepted event.
- Retention removes terminal event history before referenced run summaries;
  workspace purge removes event/window state before workflows and versions.
  No deletion leaves a payload, key window or blocking foreign key behind.

## HTTP and editor behavior

- Webhooks return 202 with a typed coordinated outcome (deduplicated, debounced,
  throttled or refused) and event ID when no run is admitted immediately. The one
  exception is a workspace whose pending events are full: that answers 429 with
  `Retry-After`, because nothing is kept and a sender retries on a 429 and never on
  a 202. The refusal stays in the history. Normal
  admitted responses and F29 skips keep their existing shape. Deferred events
  always acknowledge asynchronously, including response-mode webhooks; later
  Respond to webhook steps cannot send a second HTTP response.
- Forms show an explicit pending, duplicate, throttled or refusal message.
  Accepted pending work is not presented as an already running workflow. Retain
  the ordinary thank-you/redirect only for immediate admitted submissions.
  Public responses expose no run link, key, policy expression or internal data.
- Webhook delivery history retains its original HTTP admission outcome and joins
  current coordination status/reason/run. Forms gain the same metadata history
  for editors. Show pending due time, coalesced, started, skipped and refused
  clearly. No payload/history viewer or operator replay subsystem.
- Usage shows coordinated-event counts beside ordinary run and skip counts;
  one immutable fact per new event, not per scan/retry. These counts are separate
  measures, never a bill or an additive run total.
- Reuse Weft controls, Status and RecentLog. Key controls use the ordinary value
  mapping model. Explain fixed windows, latest-event behavior, bounded delays,
  current publication cancellation and asynchronous acknowledgement. Keep phone,
  keyboard, reduced-motion and uncertain-command behavior.

## Delivery and acceptance

One F25 PR. Move-only commits first group shared mapping contracts/resolution
and split trigger schemas into endpoint, delivery and schedule owners, keeping
new coordination references acyclic. Imports change with each move. Logic/docs follow separately; every commit is buildable and
passes its relevant lint, type and tests. No new infrastructure or accounts.

Prove real PostgreSQL same-key races, tenant isolation, expiry boundaries,
latest-event replacement, FIFO/token behavior at actual admission, queue and
concurrency refusals, double scans/restart, publication/endpoint invalidation,
budgets, exact replay, payload clearing, populated upgrade, retention and purge.
Run real worker and API/browser webhook + form journeys with controlled local
requests, desktop/phone settings and visible history/usage. Normal repository
checks, mocked e2e, React Doctor and green exact-head CI gate merge.

## Qualification — 2026-10-17

- Real PostgreSQL: 18 coordination cases, 27 webhook cases, and 37 existing
  form/statistics/populated-upgrade cases pass (82 total). Covers same-key races,
  workspace isolation, fixed expiry, latest-event replacement, concurrent scanners
  after restart, FIFO/token accounting, queue deferral and 15-minute refusal,
  concurrency, invalidated publication/endpoint, budgets, payload clearing,
  metadata pagination, discovery fences, retention and workspace purge.
- The existing owned `webhook-responses` browser scenario passes four journeys:
  all three policies through signed ingress and the real worker; a public Form
  pending receipt and editor history; ordinary synchronous replies; Secret URL,
  CORS and CSV reply regression coverage. UI setup, numeric scratch validation,
  metadata history and usage are exercised at desktop and 375px. Screenshots
  inspected. No external service or new scenario/job.
- Full unit, mocked browser, lint/type/build, generated contract, schema,
  architecture and dependency gates are required. The implementation PR records
  their final counts and exact-head CI. React Doctor reports 100/100, no findings.
- Qualification caught and fixed first-key creation races (the old admission
  fence uses shared locks), timestamp decoding at raw SQL boundaries, the new
  replay-reference column grant and current-status presentation for retried
  deliveries. Exact retries retain their original receipt and count once.

## Later work

Policy composition, workflow deduplicate step, external coordination providers,
per-customer bounds, payload inspection, replaying refused events and billing.

## Tracker

- [x] Current code reconciled; recommended decisions recorded before code.
- [x] Shared persistence and admission qualified.
- [x] All three modes qualified with real worker/API flows.
- [x] Editor/history/usage and guides qualified.
- [x] Local acceptance and release gate recorded. The implementation PR must
  have green exact-head CI before merge and records the release receipt.

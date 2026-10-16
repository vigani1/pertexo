# F15 — Respond to webhook

Status: implemented and locally qualified. Updated: 2026-10-16.
[Roadmap](../product-roadmap.md). Decision: [ADR 081](../adr/081-bounded-webhook-responses.md).

## Outcome and current code

Signed webhook ingress durably accepts a published run and returns 202 today.
Keep that default. Opting into **When the workflow responds** lets an original
webhook run reply through a **Respond to webhook** step while execution stays on
the worker. The API waits only for committed data, never executes steps.

Current owners: `api/webhooks/ingress`, `database/triggers/webhooks`, immutable
trigger projections, worker per-attempt capabilities, `nodes-core/flow`, node-sdk,
contracts, and the existing editor setup/input controls. Extend them; no new
service, transport, role, global store or CI job. The pure engine is unchanged.

## Decisions and rules

- Webhook config adds `responseMode`: `immediate` (default) or `workflow`, and
  `responseWaitSeconds`: default 10, integer 1–30. Old `{}` configs preserve their
  existing publication checksum and immediate behavior. One shared node config
  schema also serves trigger projection; no copied webhook validator. The
  legacy empty-webhook-config SQL check becomes an object-shape check;
  TypeScript owns the allowed settings and ranges.
- Preview definition/executor checks use the SDK's existing identity grammar,
  including underscores. The live journey exposed their older SQL regex, which
  rejected already-valid steps such as Read file. Reuse the SDK schema at the
  preview boundary and its pattern for the structural SQL backstops; do not
  invent another naming format or rename nodes to bypass a persistence bug.
- At verified ingress admission, copy the opt-in policy from that exact
  published trigger into one workspace-bound response record for the new run.
  A response record is never created for manual starts, Calls, replay, recovery
  or preview, even when their source/version uses a webhook trigger.
- `core.respond_webhook@1` has one ordinary input and output link. Config chooses
  JSON or text; mapped input supplies `body`, optional `statusCode` (default 200)
  and optional headers. Execution writes the response and returns a small
  receipt, then the workflow continues. It does not terminate the run.
- Allow final status codes 200–599. 204, 205 and 304 require an empty text body.
  JSON is serialized once; text must be text without null characters. Body is at most 1 MiB UTF-8,
  including JSON encoding. The registry owns JSON validation; preserve body
  object keys verbatim without a second parser stripping names. Existing
  engine/input envelopes remain bounded too,
  so mapping/config overhead can reduce the usable payload. No file response,
  arbitrary binary, streaming, redirects or HTML response mode in this slice.
- Headers use a closed list: `content-language`, `retry-after`, `x-request-id`
  and `x-correlation-id`, at most four, with bounded plain values and no control
  characters. Content-Type is generated for JSON/text. Always send
  `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. Refuse all other
  names, including Set-Cookie, hop-by-hop, Content-Length and Location; do not
  silently drop unsafe headers.
- First committed response wins across nodes, branches, iterations, retries and
  worker instances. Persist under the current attempt's owner/fence, current
  invocation and live run; cancellation/expired leases cannot write. A repeated
  attempt of the winner recovers its receipt. Other response steps return an
  explicit already-responded receipt and continue. This durable CAS makes the
  step safe to repeat; storage failures use existing safe retry rules.
- A run without an original waiting-webhook record returns an explicit
  not-waiting receipt. Preview validates/serializes but returns a preview-only
  receipt. Neither can send an HTTP response. Replayed/recovered executions
  never modify their source run's response.
- The API reads by the verified request's workspace/run identity. A committed
  response takes precedence over a later run failure. If the run fails or enters
  unknown-outcome attention before any response, return 500 with only the fixed
  safe code `webhook.workflow_failed`, never provider messages or run data.
- Each signed HTTP request waits at most its captured 1–30 second policy. On
  timeout, cancellation or completion without a response, return the existing
  202 `{runId,replayed}` receipt. Execution continues. An exact signed ingress
  duplicate refers to the original run and may read its retained response;
  it never starts another execution or re-sends a response through a worker.
- Use short indexed PostgreSQL reads every 250 ms, releasing the connection
  between reads, with at most 32 waits per API process. With all 32 waits pending, polling is about
  128 indexed reads/second per instance, plus initial lookups; measure this
  bounded-pending case in integration tests. This is not a new request-rate limiter.
  Excess waits return the durable 202 receipt immediately. This deliberately
  avoids a second pub/sub transport or an in-memory cross-instance promise
  registry. Different API instances/restarts read the same committed record.
- Abort wait timers and reads on client disconnect or API shutdown; never cancel
  an accepted run. No transaction or pooled connection is held while sleeping.
  The deadline aborts in-flight reads too. A response observed before that
  abort wins; otherwise return 202. No background waiter survives its request.
- Body and header data have run-data visibility and the existing 30-day detail
  retention after completion. Expired records are not served even before the
  reaper deletes them. Cleanup and workspace purge remove response records
  before runs; audit/events/notices carry no response body or headers.
- Delivery history remains the durable admission log. Its 202 means accepted,
  including when an opt-in caller later receives another status or disconnects.
  Label it **Admission**. The Respond step's receipt records the winning status;
  never claim a socket received data merely because it was stored.
- Deploy matching readers/writers with the additive migration; exact schema-head
  readiness rejects mismatched writers. Roll back by publishing immediate mode;
  already accepted work continues.

## Structure

| Owner | Responsibility |
| --- | --- |
| node-sdk | Typed worker response capability and shared safe wire contract |
| nodes-core/triggers/webhook | Opt-in config schema; backward-compatible defaults |
| nodes-core/flow/respond-webhook | Response input validation, serialization, manifest, executor |
| database/schema/triggers + triggers/webhooks/responses | Original-run correlation, fenced first winner and private reads |
| worker/attempts | Scoped capability from the real attempt; previews cannot persist |
| api/webhooks | Bounded request lifetime, waiting, safe status/body adaptation |
| web/workflow-editor | Existing Weft setup fields, mapped body/status/headers, clear limits |
| lifecycle | Detail expiry and workspace purge |

No file moves are needed. Any later required move gets its own buildable commit.

## Slice and evidence

| Part | Status |
| --- | --- |
| Reconcile plan and accept ADR | Done |
| Contracts, node, durable correlation and fenced worker write | Implemented |
| Bounded multi-instance API waiting and backward-compatible ingress | Implemented |
| Editor, guide and integrated qualification | Implemented and locally qualified |

One feature PR completes all parts. Required local checks: root lint/types/build,
unit/contracts/schema/boundaries, PostgreSQL isolation/fencing/retention and
race tests, worker integration, mocked browser desktop/phone and React Doctor.
Qualify a real browser-authored webhook → Respond → following step run, actual
signed HTTP response, and unchanged immediate behavior. Real two-API-instance
HTTP tests cover first winner, timeout, disconnect, restart/exact duplicate,
failure, large/unsafe payloads and bounded concurrent waits. Green PR CI before
rebase merge; inspect the natural main result.

Local qualification on 2026-10-16: root checks; 9,320 package unit tests;
194 mocked browser tests; 54 PostgreSQL tests (including populated upgrades,
expiry, isolation, fencing and purge); 9 real HTTP tests; worker transport;
and a real browser-authored webhook → Respond → following step journey.
React Doctor: 100/100. The two API listeners read the same PostgreSQL result;
32 pending waits used 128 indexed reads within their one-second budget.

## Later

Streaming, file/binary responses, public unauthenticated webhooks, redirect
responses and indefinite waits. Human waits and child Calls remain ordinary
workflow behavior; they cannot extend the caller's bounded wait.

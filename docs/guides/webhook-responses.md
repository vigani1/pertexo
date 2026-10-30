# Respond to a webhook caller

A Webhook trigger normally replies **202 Accepted** with the run ID as soon as
Pertexo saves the run. Execution happens on the worker.

To return a workflow result, open the Webhook step’s **Setup**, choose **When
the workflow responds**, and set a wait between 1 and 30 seconds (10 by default).
Add a **Respond to webhook** step, choose JSON or text (plain text or CSV), and map its `body`
on **Inputs**. Map `statusCode` to change the default 200. Connect its outgoing
link when more work should follow: replying does not end the run.

For example, after validating an order, map a JSON body from earlier steps:

```json
{"accepted": true, "orderId": "order-123"}
```

Map `statusCode` to `201` if the result represents a newly created resource.
For text, choose **Plain text** and map a text value such as `Order accepted`.
Status 204, 205 or 304 requires a text response with an empty body.

## What the caller receives

- The first committed Respond step supplies the response. Later Respond steps
  say `already_responded` and continue without replacing it.
- If the workflow fails before responding, the caller gets 500 with only
  `{"code":"webhook.workflow_failed"}`. Provider errors and run data are never
  included in this automatic failure response.
- If the wait ends first, or execution finishes/cancels without responding,
  the caller gets 202 with `runId` and `replayed`. The run keeps its ordinary
  lifecycle. Long waits, approvals and child workflows do not extend this wait.
- Under heavy load, an API instance can return the durable 202 receipt
  immediately instead of holding another socket open.
- Disconnecting never cancels an accepted run. An exact, correctly authenticated
  webhook retry refers to the same run and can retrieve its retained response.
  It does not execute the workflow again.

Signed mode keeps its signature and timestamp checks. Every authentication mode
uses the same deduplication and POST-attempt limits. Preflight has a separate
60-attempt/minute client-address guard.
The delivery history’s **Admission** status records acceptance/rejection, not
whether a caller later received a workflow response. The Respond step’s output
records the winning response status.

## Limits and privacy

Bodies are at most 1 MB in UTF-8, including JSON encoding. Normal engine/input
limits still apply; mapping and settings overhead can reduce the usable body.
Use a smaller response if it does not fit. Plain text cannot contain a null
character; JSON can encode one. JSON, plain text and CSV only; no HTML, XML,
binary files, streaming or redirect responses. Each of those could run script in
the browser of someone who opens the link, on this app's address, or send them
somewhere else. To answer a service that wants XML, send it as plain text if it
accepts that.

An optional mapped `headers` object accepts `content-language`, `retry-after`,
`x-request-id`, `x-correlation-id` and non-reserved custom x- headers. Use at most
16 headers with 1,024 ASCII characters per value. Names are case-insensitive and
normalized to lowercase; duplicates and control characters are refused. Proxy,
forwarding, security and Pertexo headers cannot be overridden. Pertexo generates
Content-Type (with UTF-8 charset), `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that keeps a
browser from running anything in the response. Set-Cookie, Content-Length, Location and
hop-by-hop headers are unavailable.

Only an original webhook run with this mode enabled can reply. Manual runs,
child Calls, replay, recovery and editor tests never reply to its caller. A
preview checks the proposed response and returns a `preview` receipt.

Response data follows run-detail retention: 30 days after completion, with
workspace purge. Expired data cannot be served while awaiting cleanup. Response
bodies and headers are never placed in audit, email, notices or error summaries.

For browser access and authentication modes, see [Receive webhooks](webhooks.md).

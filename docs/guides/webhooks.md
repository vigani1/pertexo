# Receive webhooks

Publish a workflow with a **Webhook** trigger, open **Triggers**, and create its
endpoint. Store the address and secret when shown: Pertexo cannot show them
again. Send a POST whose UTF-8 body is JSON (`application/json` or any
`+json` type), a form (`application/x-www-form-urlencoded`) or plain text, at
most 256 KB, or a GET with a query string. A POST may also come without a body.
Every accepted event starts work on the worker. The default response is 202
with the run ID.

For a single-server installation, the public address is
`https://<app host>/hooks/<key>`, on the same host as the editor, for example
`https://app.example.com/hooks/<key>`. Use the exact address from **Triggers**;
there is no `/v1` prefix. Caddy sends `/hooks/*` directly to the API,
keeping credential paths out of nginx. Its default log encoder redacts the
entire URI, including when the API is unavailable. Preserve that protection in
any customized proxy or access logger.

## Listen for a test event

You can try a saved Webhook trigger before publishing. Select it in the editor,
open **Test**, choose **Test authentication**, and select **Listen for test
event**. Pertexo saves the draft and opens a separate test URL for two minutes.
It captures the first authenticated request without starting the workflow.
Production webhooks keep working independently.

Use the shown test URL and temporary signing/header secret, rather than your
production credentials. Signed is the default; its timestamp and signature work
exactly as described below. Secret URL is convenient for a sender that cannot
sign, but anyone with that address can send your sample. Header secret supports
Authorization: Bearer or a dedicated header. Browser origins are optional and
follow the same exact-origin rules below. The single-server public test address
is `https://<app host>/hooks/<temporary key>/test`.

For example, choose Secret URL and send a small sample from your terminal:

```sh
curl --request POST "$PERTEXO_TEST_WEBHOOK_URL" \
  --header 'Content-Type: application/json' \
  --data '{"orderId":17,"amount":24,"currency":"EUR"}'
```

The receipt is `202 {"captured":true}`. Review **Received test data**, then select
**Keep as pinned sample** and confirm. Check for secrets first: request data is
not automatically sanitized beyond the credential/proxy header removal described
below. Keeping the sample shares it with people who can see run data. It uses
the normal [pin rules](pinned-samples.md), including conflicts, stale setup,
retention and omission from workflow exports. Published runs never use the pin.
You can then use **Test workflow** to run the draft with the captured trigger
output and your other pins.

A listener captures one request, not a request history. The body is limited to
256 KB and the resulting sample must also fit the existing 256 KB, depth and
member limits. Full-request headers/query count toward that result. Send a
smaller sample if it is too large. Stop/restart invalidates the old URL. Closing
the panel stops it when possible; expiry is authoritative. Editing the trigger's
setup requires listening again. One listener per workflow and ten per workspace
keep capture bounded. Unauthenticated attempts count toward a 60-attempt limit
per listener. A temporary capture disappears after ten minutes unless kept as a
pin. Failed/stopped/expired/consumed URLs use the ordinary authentication failure.
No run capacity, coordination, failure alerts or workflow responses are involved.

## What the run receives

The trigger's **Run input** setting decides what the workflow sees:

- **Data sent** (the default): the JSON value, the form fields or the text of a
  POST, or the query fields of a GET. An empty POST gives `{}`. A field sent
  more than once becomes a list of its values, in order.
- **Full request**: `{ method, body, query, headers }`. Header names are
  lowercase. Pertexo leaves out credentials (`Authorization`,
  `Proxy-Authorization`, the configured secret header), cookies, its own
  signature headers, and what proxies add (`Forwarded`, `Via`, `X-Forwarded-*`,
  `X-Real-IP` and connection headers), so they never reach run history.

## Choose authentication

**Signed** is the default and recommended when the sender supports it. Send
`X-Pertexo-Timestamp` (Unix seconds) and `X-Pertexo-Signature` (`v1=` plus lowercase
hex HMAC-SHA256 of `<timestamp>.<exact request body>`). Decode the shown signing
secret from base64url before using it as the HMAC key. Timestamp tolerance is
five minutes. The Triggers page includes curl and Node examples. The signature
covers only the body, so a Signed endpoint accepts POST only and answers GET
with 405. Treat the query and headers of a signed request as unverified.

**Secret URL** works when the sender cannot sign or attach a header. The entire
random endpoint URL is its credential: anyone possessing it can start runs.
Use HTTPS. Keep it out of source control, browser bundles, analytics, access
logs and screenshots. Rotate the URL if it leaks. Pertexo redacts endpoint keys
from its own logs and traces; configure any proxy in front of it accordingly.

**Header secret** needs both the URL and the generated secret. Choose
`authorization` for `Authorization: Bearer <header secret>`, or a dedicated name
such as `x-webhook-secret`. Send the shown base64url text verbatim; do not decode
or HMAC it. Header names use lowercase letters, digits and hyphens. Transport,
cookie, proxy, content, tracing and Pertexo protocol headers are reserved.

In **Triggers → Authentication…**, changing mode or credential header replaces
both URL and secret immediately. Update senders with the newly revealed values.
Changing only browser origins keeps credentials. **Rotate URL** also takes
effect immediately. **Rotate secret** in Signed/header mode gives the previous
secret five minutes of overlap. URL mode has no separate secret to rotate.
An uncertain management command must be retried exactly before another change;
completed retries never redisclose credentials. Rotate again if the original
credential response was lost.

## Browser callers

URL/header modes can allow up to 20 exact origins, one per line, such as
`https://app.example.com` or `http://localhost:5173`. No paths, trailing slashes,
wildcards, credentials or `null` origins. An empty list allows no browser origin.
Server callers without an Origin header keep working.

Use `fetch` with `credentials: 'omit'`. Pertexo answers the endpoint's OPTIONS
preflight for GET and POST without starting a run. Preflight allows 60 attempts/minute per client
address and does not consume the endpoint POST allowance. Allowed request
headers are Content-Type, Idempotency-Key and the configured secret header. Allowed origins receive an
explicit Access-Control-Allow-Origin on the accepted receipt or workflow reply;
Pertexo never enables cookies or wildcard browser access. A configured origin
is a browser restriction, not a secret: a public page containing an endpoint URL
or header secret exposes that credential to its visitors.

## Retries and limits

Every delivery starts a run unless it names itself as a repeat. Send the same
`Idempotency-Key` (1–128 visible ASCII characters, no comma) on each retry of an
event: Pertexo returns the first result for 24 hours instead of starting another
run. "The same request" means its body bytes, media type and query string for a
POST, and its query string for a GET; headers don't count, and different
whitespace counts as different bytes. A reused key with a changed request returns
409. A sender that retries without a key can start duplicate runs, so give it a
key if it retries. To drop repeats by a value inside the event, use
[event coordination](event-coordination.md).

All modes share these rules, the per-endpoint POST allowance (600 a minute by default, `WEBHOOK_ENDPOINT_BURST_LIMIT`), workspace capacity and the metadata-only delivery log. Authentication failures
don't disclose whether an endpoint exists.

For a workflow-controlled response, see [Respond to webhook](webhook-responses.md).
Provider-specific signatures such as Stripe or GitHub remain later work in F21.

## Publishing and the address

The address, secret, authentication mode and delivery history belong to the
workflow and its webhook step, not to a version. Publish as often as you like:
senders keep using the same address, and the next delivery runs on the new
version from the moment the publish commits. A run already underway finishes on
the version it started with, including one a sender is waiting on for a
[workflow response](webhook-responses.md). Restoring an older version keeps the
address too, and archiving only pauses it until you restore the workflow.

The address stops answering when a publish removes its step, and the publish
dialog warns you first. Deliveries then get the same 401 as any unknown address.
Publishing a version that has that step again, for example by restoring it,
brings the same address and secret back; rotate them if that isn't what you want.

## When the workflow is busy

A workflow can [queue or skip at its concurrency limit](concurrency.md).
Skipped events create no run and remain visible in trigger history and Usage.

## Business events

Use optional [event coordination](event-coordination.md) in the trigger setup to
deduplicate, debounce or throttle business events by an input key. It is Off by
default and separate from transport replay. Pending events acknowledge with 202
and appear in delivery history; they do not hold a synchronous caller open.

# Receive webhooks

Publish a workflow with a **Webhook** trigger, open **Triggers**, and create its
endpoint. Store the address and secret when shown: Pertexo cannot show them
again. Send a POST with UTF-8 JSON, at most 256 KB. Every accepted event starts
work on the worker. The default response is 202 with the run ID.

For a single-server installation, the public address is
`https://<app host>/hooks/<key>`, on the same host as the editor, for example
`https://app.example.com/hooks/<key>`. Use the exact address from **Triggers**;
there is no `/v1` prefix. Caddy sends POST and OPTIONS directly to the API,
keeping credential paths out of nginx. Its default log encoder redacts the
entire URI, including when the API is unavailable. Preserve that protection in
any customized proxy or access logger.

## Choose authentication

**Signed** is the default and recommended when the sender supports it. Send
`X-Pertexo-Timestamp` (Unix seconds) and `X-Pertexo-Signature` (`v1=` plus lowercase
hex HMAC-SHA256 of `<timestamp>.<exact request body>`). Decode the shown signing
secret from base64url before using it as the HMAC key. Timestamp tolerance is
five minutes. The Triggers page includes curl and Node examples.

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
preflight without starting a run. Preflight allows 60 attempts/minute per client
address and does not consume the endpoint POST allowance. Allowed request
headers are Content-Type, Idempotency-Key and the configured secret header. Allowed origins receive an
explicit Access-Control-Allow-Origin on the accepted receipt or workflow reply;
Pertexo never enables cookies or wildcard browser access. A configured origin
is a browser restriction, not a secret: a public page containing an endpoint URL
or header secret exposes that credential to its visitors.

## Retries and limits

Use the same `Idempotency-Key` (1–128 visible ASCII characters, no comma) for the
same event. It deduplicates exact body bytes for 24 hours. Without one, exact
body bytes deduplicate for five minutes. Different whitespace counts as
different bytes. A reused key with changed bytes returns 409. All modes share
these rules, the 60-POST-attempt/minute endpoint allowance, workspace capacity and the metadata-only delivery log. Authentication failures
don't disclose whether an endpoint exists.

For a workflow-controlled response, see [Respond to webhook](webhook-responses.md).
Provider-specific signatures such as Stripe or GitHub remain later work in F21.

## When the workflow is busy

A workflow can [queue or skip at its concurrency limit](concurrency.md).
Skipped events create no run and remain visible in trigger history and Usage.

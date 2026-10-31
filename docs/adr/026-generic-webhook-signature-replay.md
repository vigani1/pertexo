# ADR 026: Generic webhook signature and replay contract

- **Status:** accepted
- **Date:** 2026-08-25

## Context

The V1 generic webhook needs a stable public address, authenticated raw payload
contract, bounded replay behavior, and atomic run acceptance. Using the public
endpoint key as the signing secret would prevent safe independent rotation, and
parsing before verification would authenticate a transformed payload rather
than the bytes the sender transmitted.

## Decision

The published node identity is `core.webhook@1`. Its graph configuration is a
strict empty object: endpoint addresses, signing secrets, delivery policy, and
health are materialized trigger state rather than workflow JSON.

Reconciliation creates the materialized trigger in `configuration_required`
state without generating credentials that no caller could recover. An
authenticated, workspace-scoped, idempotent provision command generates an
independent endpoint key and signing secret, persists only the endpoint-key
hash and the encrypted secret, and returns both plaintext values exactly once
in the original command response. Because PostgreSQL cannot both retain only
the endpoint-key hash and redisclose the key, exact command replay reports that
provisioning already completed but returns no credentials. A caller that loses
the original response uses the explicit rotation commands rather than retrying
provisioning for secret recovery. Normal trigger queries never return either
value. Separate idempotent commands rotate the public endpoint key or signing
secret. Endpoint-key rotation invalidates the old public address at commit.
Secret rotation retains the previous encrypted version only for the five-minute
overlap described below. Trigger disable or workflow archive invalidates ingress
without deleting retained delivery facts.

An endpoint belongs to its workflow and trigger step, not to a published version
(amended 2026-10-31, product-ux-01). It carries no version pointer: resolution
joins the step in whichever version is published, so a publish moves it at commit
with its address, secret, authentication mode and delivery history. Removing the
step stops it answering; publishing that step again resumes it. A secret keeps the
trigger id it was sealed under, because its encryption context names that id.

The public management interface exposes bounded trigger identity, kind, status,
health, and endpoint readiness. It does not expose endpoint-key hashes,
ciphertext, fingerprints, payloads, or secret-version references. The ingress
success response is `{ runId, replayed }` with HTTP `202`; workflow-controlled
response bodies remain unsupported.

Missing or inactive endpoints, malformed authentication headers, stale
timestamps, and signature mismatches share one non-disclosing
`webhook.authentication_failed` response. Unsupported media type, encoded body,
oversized body, malformed JSON, idempotency conflict, and admission throttling
use distinct stable problem codes because callers can correct them without
learning whether another endpoint exists.

Each published generic webhook has an opaque, unguessable endpoint key that is
independent of its encrypted random 32-byte HMAC secret. PostgreSQL stores only
the endpoint-key hash. Secret rotation retains current and previous encrypted
secret versions; the previous version is accepted only until its persisted,
five-minute rotation deadline, after which it is unusable.

Requests provide `X-Pertexo-Timestamp` as Unix seconds and
`X-Pertexo-Signature` as `v1=` followed by lowercase hexadecimal HMAC-SHA-256
over the ASCII timestamp, one `.` byte, and the exact raw request bytes. The API
performs strict decoding and constant-time comparison against eligible secret
versions. PostgreSQL time defines a five-minute window; timestamps outside it
are rejected.

The endpoint accepts JSON only, rejects content encoding, and caps the exact raw
body at 256 KiB, matching the inline input-envelope limit. After bounded body
collection and endpoint resolution, signature verification occurs before JSON
parsing, mapping, or run acceptance. Parsed JSON must fit the same inline input
contract; no artifact spill or synchronous response mode is added.

Deduplication is scoped to the endpoint. `Idempotency-Key` uses the platform's
existing one-to-128-character visible-ASCII contract excluding commas; only its
hash is stored, for 24 hours. Its canonical acceptance fingerprint is SHA-256
over endpoint identity, exact raw-body checksum, and normalized media type; the
signature timestamp is excluded so a later signed retry can resolve the same
request. Reuse with that fingerprint returns the same `202` result and run
reference; changed content returns idempotency conflict.

Without a key there is no deduplication: every delivery starts a run, even with
identical bytes (amended 2026-10-31, api-design-03). Merging byte-identical
events behind a `202` lost real ones (a button pressed twice, a repeating ping)
for senders that never read `replayed`. Business deduplication is an explicit key
or [event coordination](../guides/event-coordination.md). The fingerprint is
whitespace- and key-order-sensitive because this adapter signs and accepts exact
raw bytes; it only tells a key's exact retry from a changed request. The accepted
media type is `application/json`, optionally with only UTF-8 charset, normalized
to `application/json`. Replay resolution and mismatch detection occur before
creating another run.

For a new request, one PostgreSQL transaction commits the trigger delivery,
queued run, initial event, idempotency result, and transactional outbox before
returning `202`. The endpoint never waits for workflow execution and provides
no workflow-controlled synchronous response.

If hard ingress or queued-run admission rejects the request, none of those rows
is persisted and the API returns `429` with bounded `Retry-After`. Generic
webhook ingress does not create an independently pending delivery.

Public endpoint resolution uses one narrowly executable security-definer
function under forced RLS. It accepts only an endpoint-key hash and returns only
the minimal active trigger and eligible encrypted-secret references needed for
verification; all subsequent tenant writes run with explicit workspace context.

## Consequences

### Public management clarification

The management routes are scoped below a workflow trigger collection. Provision
and both rotation commands require `Idempotency-Key`, the existing session and
CSRF controls, and workflow-update authorization, including builders. Secret
rotation also requires the current endpoint key in its authenticated JSON
request. Its hash is bound into the idempotency request fingerprint, and
PostgreSQL locks and authenticates the active endpoint by trigger and hash before
inserting a secret version. The API also uses that key to resolve the
post-command encrypted secret-version identity, allowing
it to distinguish the original successful command from a completed replay
without persisting or logging the plaintext endpoint key. A caller that has lost
the endpoint key rotates the endpoint first. Normal trigger reads remain free of
credentials and hashes.

Before any KMS decrypt, PostgreSQL atomically consumes a durable, per-endpoint
fixed-window ingress allowance. V1 permits 60 attempts per one-minute endpoint
window and returns a `Retry-After` bounded to 1 through 60 seconds on denial.
This ingress guard is independent of workspace run admission; denial persists no
delivery, replay, run, event, or outbox facts and does not reveal whether an
endpoint exists.

Webhook trigger secrets use a dedicated envelope purpose and associated-data
shape containing workspace, trigger, and secret-version identity. They may use
the same configured AWS KMS key reference as connection secrets, but never the
connection-secret envelope purpose or associated data.

Public URL rotation and signing-secret rotation are independent, signatures
cover the actual transmitted bytes, and exact retries cannot create duplicate
runs. PostgreSQL loss fails closed. The trade-off is raw-body handling, a
bounded two-version secret window, and only short-window best-effort deduplication
when the sender omits an idempotency key.

## Rejected alternatives

- Using the endpoint key itself as the HMAC secret or storing it in plaintext.
- Accepting arbitrary authentication schemes, content types, encodings, or
  oversized artifact-backed bodies in V1.
- Parsing, canonicalizing, or decompressing the body before signature checking.
- Comparing signatures with ordinary string equality or application wall time.
- Unbounded previous-secret acceptance or more than current and previous.
- Returning `202` before delivery, run, event, and outbox commit.
- Synchronous workflow-controlled webhook responses.
- A broad security-definer repository that bypasses normal tenant writes.

## Accepted amendment — 2026-10-17

The owner approved three explicit authentication modes per materialized webhook
endpoint: Signed (unchanged default), Secret URL (the unguessable address alone),
and Header secret (the existing encrypted random secret in Bearer or one safe
named header, compared in constant time). Authentication policy remains outside
workflow JSON. See the [implementation plan](../feature-plans/webhook-authentication.md)
for bounds and owner locations.

Changing mode or credential header atomically rotates both address and secret,
without overlap across modes. Existing independent rotations retain their
semantics, including five-minute secret overlap within a mode. Configuration
uses the same authorization, CSRF, idempotency and once-only reveal rules.
Admission rechecks the proof's policy and eligible credential under locks.
All modes retain the delivery log, raw-byte deduplication, rate limit and single
non-disclosing authentication failure. The historical `signatureCheck` field
now denotes authentication by the selected mode; its stored shape is unchanged.

URL/header modes may allow exact browser origins, with endpoint-only preflight
and explicit CORS response headers, never credentials or wildcards. Preflight
uses the existing Nest public-route limiter before endpoint discovery (60/minute
per client address, fail closed). It does not consume the POST endpoint allowance,
decrypt a secret, create a run or write a delivery row. Origin is a browser
restriction, not a substitute for the endpoint's credential. It does not grant Pertexo session access. URL credentials must be excluded from logs
and telemetry. Provider-specific signatures remain F21.

ADR 081 already supersedes the original prohibition on synchronous replies.
Its shared safe response contract now permits bounded non-reserved custom x-
headers and explicit text/csv or application/xml text formats. HTML remains
blocked, as do cookies, hop-by-hop headers and response-control overrides.

## Accepted amendment — 2026-10-19

The owner approved wider webhook requests, as n8n, Zapier and Make accept them
([plan](../feature-plans/step-capability-upgrades.md)). A POST body may be UTF-8
JSON (`application/json` or a `+json` type), form-encoded fields or plain text,
with an optional `charset=utf-8`; an empty POST may omit the media type. Other
media types and any content encoding still get 415. GET is accepted on Secret
URL and Header secret endpoints. Signed endpoints answer GET with 405, because
the signature covers the exact body bytes and a GET has none. HEAD never starts
a run.

The trigger's Run input setting chooses the body (the query for GET, today's
shape and the default) or `{ method, body, query, headers }`. Credentials,
cookies, Pertexo signature headers and proxy-added headers are withheld, so
they never reach stored run input. Query and headers stay unsigned in Signed
mode.

The 24-hour key window stays. The request fingerprint of a JSON POST
without a query is unchanged, so retries across the upgrade still match. A
POST adds its lowercase media type and, when present, the exact query string; a
GET uses its exact query string. Headers never count.


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
in the completed command result. Exact command replay may return that same
one-time result during the command's 24-hour idempotency window; normal trigger
queries never return either value. Separate idempotent commands rotate the
public endpoint key or signing secret. Endpoint-key rotation invalidates the
old public address at commit. Secret rotation retains the previous encrypted
version only for the five-minute overlap described below. Trigger disable or
workflow archive invalidates ingress without deleting retained delivery facts.

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

Without a key, the generic adapter's canonical payload fingerprint is the same
endpoint/raw-body/media-type checksum, retained for five minutes. It is
intentionally whitespace- and key-order-sensitive because this adapter signs
and accepts exact raw bytes; this is the adapter-defined fingerprint required by
the platform plan, not a claim of semantic JSON deduplication. The accepted
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

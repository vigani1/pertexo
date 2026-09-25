# ADR 045: Webhook delivery log

- **Status:** accepted
- **Date:** 2026-09-25
- **Related:** ADR 013 (retention), ADR 026 (webhook signature and replay)

## Context

ADR 026 persists one `app.webhook_trigger_deliveries` row per admitted request,
inside the transaction that also accepts the run. Every rejection after the
endpoint resolves (a stale timestamp, a signature mismatch, malformed JSON, an
idempotency conflict or workspace admission throttling) leaves only aggregate
telemetry. ADR 013 retains the admitted rows as 90-day run-summary metadata, but
no public read exposes them.

People integrating a sender therefore cannot see the most useful facts for
debugging: whether their requests arrive at all, whether the signature matched,
whether a retry was treated as a duplicate or a conflict, and which run an
admitted delivery started. The web Triggers tab needs a per-webhook delivery
list with honest outcomes, without weakening the non-disclosing ingress
responses or turning unauthenticated traffic into an unbounded write path.

## Decision

### What is recorded

After the endpoint key resolves to an active endpoint **and** the per-endpoint
ingress allowance from ADR 026 has been consumed, every request leaves exactly
one metadata-only delivery row. Its `outcome` uses the existing ingress
telemetry vocabulary and fixes the HTTP status that was returned:

| Outcome                 | HTTP | Meaning                                                                            |
| ----------------------- | ---- | ---------------------------------------------------------------------------------- |
| `accepted`              | 202  | Signature verified, new request, run admitted                                      |
| `replayed`              | 202  | Exact retry inside the deduplication window; the earlier run is returned           |
| `authentication_failed` | 401  | Stale timestamp, signature mismatch, or the endpoint stopped accepting in between |
| `invalid_request`       | 400  | Verified signature, but the body is not JSON or `Idempotency-Key` is malformed     |
| `conflict`              | 409  | The idempotency key was already used for different bytes                          |
| `rate_limited`          | 429  | Workspace run admission refused the run                                            |

Each row also records `signature_check` (`verified`, `mismatch` or
`not_checked`), `replay_check` (`new`, `duplicate`, `conflict`,
`stale_timestamp` or `not_checked`), the exact raw body byte count, the
deduplication kind when one was resolved, and the run identifier only for
`accepted` and `replayed`. A database check constraint binds each outcome to
its status, signature and replay values and to the presence of a run.

The following are **not** recorded, and remain telemetry only:

- requests rejected before the endpoint resolves (unknown or inactive endpoint,
  malformed endpoint key or authentication headers, unsupported media type,
  content encoding, oversize bodies), because they cannot be attributed to a
  tenant without trusting input that failed to identify one;
- requests denied by the per-endpoint ingress allowance, because recording them
  would let unauthenticated traffic write without bound;
- `503` responses while regional write admission is paused, because tenant
  writes are paused.

The worst-case row rate per endpoint is therefore one row per consumed
allowance unit (60 per minute), the same bound admitted deliveries already had.

### Transactions and ADR 026 invariants

`accepted` rows commit in the acceptance transaction exactly as before.
`replayed` rows commit in the transaction that resolves the exact replay under
the same advisory lock. Rejected rows are written afterwards in a separate short
workspace-scoped transaction. Recording is best effort: a failure to record
never changes the HTTP response, and the rejected request still creates no run,
replay record, event, checkpoint or outbox fact.

This amends one sentence of ADR 026: a post-allowance denial now persists one
metadata-only delivery fact. Everything else in ADR 026 is unchanged, including
the non-disclosing `webhook.authentication_failed` response and admission
atomicity.

Rows never contain the body, the parsed payload (which remains only in run
input), headers, the signature or timestamp values, the idempotency key or its
hash, the endpoint key or its hash, secret-version identity or the client
address.

### Retention

Rows of every outcome keep ADR 013's trigger-summary class: a 90-day
`expires_at`, removal by the existing bounded retention stage, legal hold and
workspace purge. Reads exclude rows whose `expires_at` has passed even before
the reaper removes them. Rows written before this decision are backfilled as
`accepted`, `202`, `verified` and `new`, with an unknown (null) size. The new
columns have defaults matching that backfill, so the previous API version keeps
writing correct admitted rows during a rolling deployment or rollback.

### Read contract

`GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/deliveries`
returns `{ items, nextCursor }`, newest first by `(received_at desc, id asc)`,
with `limit` 1–100 (default 25) and an opaque `after` cursor bound to the
trigger. It uses the same authority as trigger health reads: the
`workflow:read` route guard, the active owner/admin/builder database check and
the `authenticated_read` rate class. A trigger that is not a webhook, belongs to
another workflow or is not visible returns the non-disclosing `404`. Items
contain only the recorded metadata above.

## Consequences

Builders can diagnose senders from the product: missing signatures, clock skew,
duplicates and throttling are visible per endpoint with the run each admitted
delivery started. Storage stays bounded by the existing allowance and retention
class. The trade-off is one extra short write per post-allowance rejection, and
a delivery log that cannot show requests which never identified an endpoint.

## Rejected alternatives

- A separate attempts table, which would duplicate the retention, legal-hold
  and purge wiring for the same fact family.
- Recording pre-resolution or allowance-denied requests.
- Storing headers, body excerpts or hashes for debugging.
- Writing rejected rows inside the acceptance transaction, which would couple
  diagnostics to admission rollback.
- Aggregate counters only, which cannot answer “what happened to my request”.

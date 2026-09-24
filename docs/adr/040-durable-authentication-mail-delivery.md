# ADR 040: Durable identity-scoped authentication mail delivery

- **Status:** accepted — design approved on 2026-09-23
- **Date:** 2026-09-23
- **Related:** ADR 039 and the authentication/account-linking implementation plan

## Context

Better Auth issues verification, password-reset and email-change links while an
HTTP request is in progress. Development uses an in-memory sink, but production
must not acknowledge mail enqueue until a durable command exists. Token-bearing
URLs are credentials: they must not enter logs, plaintext queue payloads or
customer workflow connections.

Pertexo's existing outbox and invitation delivery records are workspace-scoped.
Authentication mail is identity-scoped, including users who have no workspace.
Using a dummy workspace or broad RLS bypass would couple unrelated authorization
models and make deletion behavior ambiguous.

## Decision

Add a dedicated authentication-mail module with one small enqueue interface for
the API and a worker-owned claim/settle interface. PostgreSQL stores message ID,
purpose, expiry, provider/sender identity, retry/lease metadata and one encrypted
payload. The sealed payload contains the recipient and immutable exact provider
request inputs, including subject/body. Associated data binds purpose, message
ID and expiry. Queue or scheduler metadata contains no recipient or bearer URL.

The API role can execute only the enqueue function and cannot read or update
delivery rows. The worker role can claim and settle through narrow functions and
cannot enqueue, read credential/session tables or bypass tenant RLS. The worker
reuses the application-owned Resend HTTP adapter and application-secret envelope,
not invitation rows, workflow credentials or customer connections.

Claim leases are 60 seconds and carry a monotonically increasing generation.
Only the active generation may settle. Each message pins the provider, sender,
exact request bytes and provider idempotency key before its first dispatch.
Timeouts, transport errors, concurrent-idempotency responses and structured 5xx
responses are outcome-unknown and retry the exact command. Terminal 4xx responses
other than concurrency are failed. There is no exactly-once-delivery claim.

At most 50 messages are claimed per bounded pass. Retry uses exponential backoff
with jitter, capped at one hour and 12 attempts, but never beyond the earlier of
the token expiry and the provider's 24-hour idempotency window. An ambiguous
message that reaches either bound becomes `reconciliation_required`; it is not
resent and no replacement token is minted automatically.

Terminal metadata is retained for 30 days. Ciphertext is cleared immediately on
confirmed submission or terminal rejection, and when a queued/unknown message
expires. Expired and terminal metadata is deleted in bounded batches after the
30-day receipt window. This slice adds no legal-hold or general messaging system.

API configuration requires an active encryption key/version whenever durable
mail is selected. Worker configuration requires that version (or an explicitly
configured previous decryption key), provider credential and verified sender.
Missing or mismatched configuration fails readiness closed. Local mail remains
development/test-only, and no real external message is sent without separate
authorization.

Owned initial-verification and email-change proofs enqueue their sealed mail in
the same PostgreSQL transaction; enqueue failure rolls back the proof or stage
transition. A password-reset proof issued by the pinned library may still
commit before a separate enqueue fails. In that case the HTTP request fails,
the undelivered proof is unusable without its link and expires normally, and
an explicit throttled resend may issue a new token. Enqueue commit is the
acknowledgement point; provider delivery remains asynchronous and recoverable.

## Consequences

The new module has a non-tenant lifecycle and must participate explicitly in
retention, key rotation, readiness and backup policy. It avoids weakening tenant
RLS or exposing token-bearing payloads to generic transport infrastructure.
Operational health can prove local configuration and queue progress but cannot
claim recipient delivery without provider evidence.

Required evidence includes actual-runtime-role denial, ciphertext-at-rest
inspection, lease-generation concurrency, crashes before and after dispatch,
exact retry across configuration changes, expiry and retention, key rotation,
and provider behavior through a fake HTTP endpoint. Production sender/domain and
real external delivery remain deployment gates.

# ADR 024: Resend email-notification provider contract

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Phase 6 requires one complete email action and a later email destination behind
ADR 022's failure-notification capability. The backend plan deliberately does
not choose SMTP or a transactional-email vendor, and it does not define the
published fields, credential form, or retry identity.

A generic SMTP connection would introduce arbitrary-host egress, DNS rebinding,
TLS and authentication variants, and no standard idempotency guarantee. Resend
offers a fixed HTTPS send endpoint, sending-only keys that can be restricted to
one domain, documented test recipients, and request idempotency retained for 24
hours. The engine V1 retry policy makes at most three attempts with at most a
60-second delay, safely inside that provider window.

## Decision

V1 exposes exactly one graph action, `email.send_notification@1`, backed by
executor ABI 2. Its integration identity is provider `email`, operation
`send_notification`. It is an `action`, `io`, `idempotent-with-key` node with
`external_http` and `side_effect_disclosure` capabilities. Resend is the V1
transport implementation; changing transport or provider is a new contract
decision, not an invisible adapter swap.

The strict config is `{ timeoutMillis }`, bounded from 1 through 30,000. The
strict input is `{ toEmail, subject, text }`: one normalized ASCII mailbox of at
most 254 characters, a subject of one through 200 characters and at most 1 KiB
of UTF-8, and plain text of one through 50,000 characters and at most 256 KiB of
UTF-8. CR, LF, NUL, display-name, and group syntax are rejected in mailbox and
subject fields. The strict output is `{ emailId }`, containing Resend's UUID.
HTML, templates, attachments, multiple recipients, CC/BCC, reply-to, custom
headers, tags, tracking controls, scheduling, and dynamic sender selection are
excluded.

The one required connection slot is `resend_api_key`. Connection provider and
auth identities are `email` and `resend_api_key`. The encrypted V1 secret is
`{ schemaVersion: 1, type: "resend_api_key", apiKey, fromEmail }`. Only bounded
`re_` API keys and one normalized sender mailbox are accepted. Production setup
should use a sending-only key restricted to the sender's verified domain.
Creation, rotation, revocation, current-version fencing, credential-access
audit, and workspace RLS reuse the existing connection boundary.

Because a sending-only key has no side-effect-free account-inspection endpoint,
connection testing is explicitly side effecting. Its strict request requires
`{ providerKey: "email", sideEffectDisclosureAccepted: true }`. It sends one
plain-text message from the pinned sender to Resend's documented
`delivered@resend.dev` test recipient with an idempotency key derived from the
connection-test idempotency key. It uses the production client and records only
safe health state. No arbitrary recipient or message is accepted by this path.

The server adapter calls only `https://api.resend.com/emails` with JSON, bearer
authorization, and the engine's stable provider idempotency key. Redirects and
hidden SDK retries are disabled. Request and response bodies are bounded; only
the returned UUID or bounded documented error type is parsed. The API key,
sender, recipient, subject, text, full response, and headers never enter logs,
telemetry, queue payloads, or safe error summaries.

The worker resolves the credential just in time, verifies the immutable secret
version immediately before dispatch, and commits ADR 007's dispatch marker
before bytes may leave the process. HTTP 400, 401, 403, and 422 plus
`invalid_idempotent_request` are definite failures. HTTP 429,
`concurrent_idempotent_requests`, definite pre-dispatch transport failures, 5xx,
timeouts, and post-dispatch transport ambiguity are retryable with the identical
payload and idempotency key. Automatic retries are permitted only under the
accepted V1 engine retry policy, whose complete horizon is well inside Resend's
24-hour idempotency retention. A future policy that can cross that window must
fail closed or receive a new decision before this executor is eligible for it.

Preview validation is offline. Test execution performs the real email side
effect only after the existing disclosure acknowledgement and uses the same
bounds, credential fence, idempotency key, timeout, redaction, and outcome
classifier as production.

The later email failure-notification destination reuses the proven low-level
send adapter behind ADR 022's provider-neutral capability. It does not add a
workflow node, change notification identity, or alter terminal run truth.

## Consequences

V1 gains safe, deduplicated transactional email without exposing an arbitrary
mail relay or a large content surface. Sender identity is centrally controlled
by the connection and cannot be supplied by workflow data. The trade-offs are a
named Resend dependency, plain-text single-recipient scope, and a disclosed test
email when users ask to verify a sending-only connection.

## Rejected alternatives

- Generic SMTP, arbitrary API endpoints, or a speculative multi-vendor facade.
- Full-access API keys solely to obtain a side-effect-free account endpoint.
- HTML, templates, attachments, bulk recipients, or dynamic sender identity in
  the first release.
- Treating an idempotency key as durable beyond Resend's documented 24 hours.
- Testing credentials by sending to a user-selected or real external recipient.
- Shipping the manifest before connection, preview, recovery, and rollout proofs.

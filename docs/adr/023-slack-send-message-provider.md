# ADR 023: Slack send-message provider contract

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Phase 6 requires one complete Slack action and a later Slack destination behind
the failure-notification capability from ADR 022. The backend plan does not fix
the action fields, credential form, or retry identity. Those details become
published compatibility identity and must be bounded before implementation.

Slack's `chat.postMessage` method accepts bot tokens with `chat:write`, requires
a channel-like ID, recommends text no longer than 4,000 characters, and applies
special per-channel and workspace rate limits. The method does not provide a
documented provider idempotency guarantee suitable for replaying an ambiguous
request.

## Decision

V1 exposes exactly one graph action, `slack.send_message@1`, backed by executor
ABI 2. Its integration identity is provider `slack`, operation `send_message`.
It is an `action`, `io`, `unsafe` node with `external_http` and
`side_effect_disclosure` capabilities. It remains absent from serving cohorts
until the complete staged rollout passes.

The strict config is `{ timeoutMillis }`, bounded from 1 through 30,000. The
strict input is `{ channelId, text }`: `channelId` is an uppercase Slack
channel-like ID beginning with `C`, `D`, `G`, or `U`, and `text` contains one
through 4,000 characters and at most 16 KiB of UTF-8. The strict output is
`{ channelId, messageTs }`, where `messageTs` is Slack's bounded decimal message
timestamp. V1 always sends one accessible top-level text message with link and
media unfurling disabled. Blocks, attachments, threads, reply broadcast,
metadata, files, scheduling, custom authorship, dynamic option lookup, and
channel discovery are excluded.

The one required connection slot is `slack_bot_token`. Connection provider and
auth identities are `slack` and `slack_bot_token`. The encrypted V1 secret is
`{ schemaVersion: 1, type: "slack_bot_token", botToken }`; only modern `xoxb-`
bot tokens are accepted. Creation, rotation, revocation, current-version
fencing, credential-access audit, and workspace RLS reuse the existing
connection boundary. Connection testing makes one bounded `auth.test` call and
persists only safe health state, never token or provider response material.

The server adapter calls only `https://slack.com/api/chat.postMessage` with JSON
and bearer authorization. Redirects and hidden SDK retries are disabled. The
response body is capped at 64 KiB and only `ok`, `channel`, `ts`, and bounded
`error` are parsed. The token, request text, full response, and headers never
enter logs, telemetry, queue payloads, or safe error summaries.

The worker resolves the credential just in time, verifies the immutable secret
version again immediately before dispatch, and commits ADR 007's dispatch marker
before bytes may leave the process. Definite local validation, authentication,
permission, and channel errors fail without retry. HTTP 429 honors a bounded
`Retry-After`; definite pre-dispatch transport failures and explicit Slack
service-unavailable responses are retryable. A timeout, connection loss, abort,
or unexpected 5xx after dispatch is `outcome_unknown` with
`possiblyDispatched: true`. Because V1 has no provider idempotency guarantee, an
ambiguous call is never automatically replayed.

Preview validation is offline. Test execution performs the real side effect only
after the existing disclosure acknowledgement and uses the same bounds,
credential fence, timeout, redaction, and outcome classifier as production.

The later Slack failure-notification destination reuses the proven low-level
send adapter behind ADR 022's provider-neutral capability. It does not add a
workflow node, change notification identity, or alter terminal run truth.

## Consequences

The first Slack slice is useful for the launch journey without committing the
catalog to Slack's broader API. Dynamic channel IDs support mapped workflow data
without a provider lookup. The trade-off is at-least-once ambiguity without
automatic retry after a possibly dispatched request; users must replay the run
explicitly when outcome is unknown.

## Rejected alternatives

- A broad Slack operation catalog or generic messaging abstraction.
- Blocks, attachments, file upload, threads, impersonation, or scheduled posts
  in the first release.
- User, legacy, app-level, workflow, or plaintext untyped tokens.
- Treating `client_msg_id` or the engine provider key as guaranteed Slack
  idempotency without a documented provider contract.
- Retrying ambiguous unsafe dispatches.
- Shipping the manifest before connection, preview, recovery, and rollout proofs.

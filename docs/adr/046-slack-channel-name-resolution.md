# ADR 046: Slack channel-name resolution

- **Status:** accepted
- **Date:** 2026-09-25
- **Related:** extends ADR 023 (Slack provider); ADR 025 (failure-notification
  destinations)

## Context

ADR 023 deliberately excluded channel discovery: Slack steps and ADR 025
failure-notification destinations store strict channel IDs, and delivery only
ever uses those IDs. The product therefore shows `#C0123ABCD` where people
expect `#ops-alerts`, which makes destinations hard to recognise and easy to
misconfigure.

Slack's `conversations.info` method returns one conversation's name for a bot
token. It requires `channels:read` for public channels and `groups:read` for
private channels; without the matching scope it answers `missing_scope`, and
for an unknown or inaccessible conversation `channel_not_found`. It is a
Tier 3 read method and has no side effects.

## Decision

Extend ADR 023 with one bounded, read-only lookup. It is display metadata only:
names are never stored, never used for authorization, and never replace the ID
that delivery and Slack steps use.

- **Client.** The existing fixed-origin Slack client gains
  `lookupChannel`, which posts one form-encoded `channel` parameter to
  `https://slack.com/api/conversations.info` with bearer authorization, no
  redirects, the existing 64 KiB response cap and redaction of the token. It
  parses only `ok`, bounded `error`, `channel.id` and `channel.name`; a returned
  ID that differs from the requested one, or a name outside 1–80 letters,
  digits, marks, `.`, `_` or `-`, is an invalid response. The token and
  response bytes are zeroed or dropped as for `auth.test`.
- **Route.** The Slack module declares the `channels` lookup on the shared
  connection lookup route in [ADR 095](095-integration-modules.md). It accepts
  1–10 unique channel IDs in `input.channelIds` and returns items in request
  order. Each item has the channel ID as its `value` and the name as its
  `label`; unresolved items use the ID as the label and carry an
  `unavailableReason`.
- **Credential use.** The shared lookup route requires `connection:use` and
  uses the `provider_test` rate class. The connection runtime checks access
  before reading the current secret, audits its use with purpose
  `slack.channels.lookup`, and checks it again before each dispatch. It
  decrypts the secret just in time and zeroes the plaintext afterwards.
  The token never leaves the server except in the authorization header to
  Slack. A connection that is not visible is the non-disclosing `404`.
- **Bounded work.** Lookups run sequentially with a 5-second timeout per call
  inside a 15-second budget bounded by the request. Direct-message and user IDs
  (`D…`, `U…`) have no channel name and are answered without a provider call.
  A `channel_not_found` affects only that channel; every other failure stops the
  remaining calls and gives them the same reason, so a revoked token, a missing
  scope or throttling never multiplies provider traffic.
- **Honest “can't resolve”.** Unresolved reasons are `missing_scope`,
  `not_found`, `connection_unavailable` (connection revoked, needs
  reauthorization, is not a Slack bot-token connection, or Slack rejects the
  token), `rate_limited`, `provider_unavailable` and `not_a_channel`. They are a
  successful `200` response, not an error, so pages never fail because a name
  could not be read. The lookup never changes connection health; the explicit
  connection test remains the only health signal.
- **Caching.** The repository has no server-side cache for provider data, so
  resolution is per request and bounded as above. Browsers keep the result in
  their query cache for a few minutes.

The web Alerts rows and the destination lens show `#name` when it resolves and
the channel ID with a short reason when it does not.

## Consequences

Destinations become recognisable without storing provider data or widening what
delivery depends on. Slack apps that want names must grant `channels:read`
(and `groups:read` for private channels); without them the UI explains why only
the ID is shown. The trade-off is a small amount of provider read traffic per
page view, bounded by the rate class, the per-request limit and the browser
cache.

## Rejected alternatives

- Channel discovery or search (`conversations.list`), which ADR 023 excludes
  and which would page through every conversation the bot can see.
- Persisting names on destinations or steps, which would go stale on rename and
  make display data look authoritative.
- A server-side name cache without an existing cache pattern or invalidation
  signal.
- Treating lookup failures as errors or as connection-health changes.

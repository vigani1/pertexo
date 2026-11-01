# F21 slice 0 — Generic OAuth2 connections for HTTP Request

Status: **Built; awaiting the owner's sandbox proofs.** Parent: [F21](21-integrations-and-polling.md).
Numbered rules (S, L, D) are what the tests check, so a change to one is a change
to this plan.

## Outcome

An owner or admin connects any OAuth2 service by filling in its addresses and
client, consents in a browser, and HTTP Request steps then call its API with a
token that renews itself. If the grant breaks, the connection says so and can be
reconnected without touching the workflows that use it.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Grant types | Authorization code and client credentials | n8n offers both; client credentials only swaps refresh for a new request, so it costs one branch |
| PKCE | On by default with S256; an Advanced switch turns it off; `plain` isn't offered | RFC 9700 asks for it and servers ignore what they don't know; a rare server refuses it |
| Client authentication | Basic header by default, request body as an option, per RFC 6749 §2.3.1 encoding | n8n's Header/Body choice; RFC servers must support basic |
| Scope | One string, sent as typed | Services disagree on separators; n8n does the same |
| Extra parameters | Authorization and token parameters, reserved names refused | Google needs `access_type=offline`; Auth0 needs `audience` |
| Consent window | Opens in a new window; the page you were on stays | Keeps an unsaved editor draft, as n8n, Zapier and Make do |
| Where tokens live | A new row per connection, not `connection_secret_versions` | Refresh must not change `secretVersionId`: it fences in-flight steps and is the replace form's version check |
| New connection's status | `reauthorization_required`, code `connection.oauth2_not_authorized`, no new status | Everything already fails closed on "not active"; a fourth status touches every consumer for no behavior. Only attention surfaces read the code: the inbox, mail and overview stay quiet about a connection nobody has signed in to |
| Who may consent | `connection:manage`, like every other credential change | Consistent with today |
| Serialization | A blocking time on the token row plus a version check, not a lock across HTTP | `withConnectionTransaction` takes the workspace's run-admission lock, so holding it through a 15 s call would stall run admission |
| Refresh timing | On use only; no background job | No scanner needed; an unused grant that lapses shows at next use |
| API 401 | Renew and repeat once for GET and HEAD only; never for anything else | RFC 9110 makes those two safe; nothing proves a 401 means a POST did nothing |
| Allowed hosts | Per connection, default any host | n8n's "Allowed HTTP Request Domains"; default matches header connections |
| Revoke | Deletes tokens here; doesn't call the provider | n8n doesn't either; RFC 7009 support is uneven |
| ADR | None | Tables and a union are reversible by migration; nothing here is hard to reverse |

Stop rule: no new package, subsystem or format. Provider HTTP goes in
`packages/integrations/src/oauth2`, storage in `packages/database/src/connections/oauth2`,
and `node-sdk` gains two optional runtime methods.

## What a person does

### Roles

| Role | Capability | May |
|---|---|---|
| Viewer | `connection:read` | See the connection, its settings (never the secret) and status |
| Operator, Builder (the "Editor" roles) | + `connection:use` | Also pick it in steps and test it, within connection sharing |
| Owner, Admin | + `connection:manage` | Also create, connect, reconnect, change settings, share and revoke |

Other workspaces get 404, as for connections today. Manage and use need an active
workspace; read also works in a browsable one.

### Create and connect

Connections → **HTTP**. The credential step gains a choice: **Headers** (today's
form) or **OAuth2**.

Form, top to bottom:

- **Redirect URL**, read only with a copy button. Help: "Register this address
  with the service first." Its value is `<origin>` + `OAUTH2_CALLBACK_PATH`.
- **Sign-in type**: **Sign in with consent** (authorization code, default) or
  **Server to server** (client credentials, which hides Authorization URL, PKCE
  and authorization parameters).
- **Authorization URL**, **Token URL**, **Client ID**, **Client secret**, **Scope**.
- **Advanced**: **Client authentication** (Basic header / Request body), **PKCE**
  (on), **Extra authorization parameters**, **Extra token parameters**, **Allowed
  API hosts** (Any host / Only these). Help on parameters: "Don't put secrets here;
  people who can see this connection can read them."

Then Name, as today. The third step is **Connect** instead of Test. It says "You'll
sign in at `<authorization host>`. Pertexo then gets its token from `<token host>`."
Both hosts are shown so a tampered address is visible before consent. Server to
server says "Pertexo gets its token from `<token host>`."

**Connect** opens the window synchronously, then calls the start route, then sets
`popup.opener = null` and navigates it. The sheet says "Finish signing in in the
window that opened." If the browser blocked the window: "Your browser blocked the
window." with a link **Open sign-in page** that has `target=_blank` and
`rel="noopener noreferrer"`. A `BroadcastChannel` named `pertexo.connections.oauth2`
and refetch on focus both move the sheet on, to the existing test panel. Testing
stays optional. A step's **New HTTP** sheet selects the connection once it is active.

### Landing page

`OAUTH2_LANDING_PATH`, a public web route that reads no data. It posts to the
channel, tries `window.close()`, and otherwise shows:

| `result` | Text |
|---|---|
| `connected` | "Connected. You can close this tab." |
| `denied` | "You didn't allow access. Nothing changed." |
| `token_refused` | "The service refused the sign-in. Check the client ID, secret and token URL. If they're right, try sending them in the request body." With the service's code when it gave one that says more: "The service's code: `<code>`." |
| `provider_unavailable` | "The service didn't answer. Try again in a few minutes." |
| `invalid` | "This sign-in link is no longer valid. Start again from Connections." |

With a connection, it also links to that connection. Every outcome is a landing page,
including a rate limit and an unexpected failure such as a KMS or database outage; those
land on `provider_unavailable`, naming the connection if the state had been read by then.

### Using it

The HTTP Request connection picker lists active OAuth2 connections beside header
ones. Nothing else in the step changes. A step can't set its own `Authorization`
header: saving refuses that name, so publishing is refused and nothing is sent.

### Detail and reconnect

Active facts: "Token renews automatically" (`renewable`), "Token expires `<time>`;
someone will need to reconnect" (not renewable, with an expiry), "The service gave
no expiry" (neither). Buttons for managers: **Reconnect**, **Edit settings**.

**Edit settings** is the replace flow: all fields prefilled except the secret,
which must be typed again. Saving always asks for new consent.

Not active: status "Needs reauthorization", with this notice and a primary
**Connect** or **Reconnect**. The list's health sentence uses the short form.

| Code | Notice | Short |
|---|---|---|
| `connection.oauth2_not_authorized` | "Not connected yet. Connect to sign in at `<host>`." | not connected yet |
| `connection.oauth2_grant_revoked` | "`<host>` no longer accepts this connection's sign-in. Reconnect to restore it." | sign-in revoked |
| `connection.oauth2_client_rejected` | "`<host>` refused the client ID or secret. Replace them, then connect." | client refused |
| `connection.oauth2_token_expired` | "The access token expired and this service gave no way to renew it. Reconnect." | token expired |

Revoke dialog adds: "Pertexo deletes its tokens. To remove access at `<host>`,
revoke it there too."

## Security rules

**State and callback**

- **S1** State is `<workspace id, base64url, 22 chars>.<256 random bits, 43 chars>`
  (`oauth2CallbackStateSchema`); the database keeps only its SHA-256.
- **S2** One consent per connection may be pending. A new start replaces the old
  one, so the older state stops working.
- **S3** State expires 600 s after start, by database time.
- **S4** State works once. Consuming is one `DELETE … RETURNING` matching workspace,
  state digest, binding digest and unexpired, so two concurrent callbacks exchange
  one code.
- **S5** Start sets `pertexo_oauth2_<connection id without dashes>`: a random 256-bit
  value, `HttpOnly`, `SameSite=Lax`, `Path=OAUTH2_CALLBACK_PATH`, `Max-Age=600`,
  `Secure` on HTTPS. The row keeps its digest. A callback without the matching cookie
  doesn't consume the row and exchanges nothing. That is what refuses a link sent to
  someone else. A cookie, not the session, because `SESSION_COOKIE_SAME_SITE=strict`
  would hide the session on a cross-site return.
- **S6** The row records who started. The callback rechecks, in the consuming
  transaction, that this user still has `connection:manage` in an active workspace.
- **S7** The workspace in the state selects row security. Changing it matches no row.
  All refusals look the same: 303 to `result=invalid`, naming no connection.
- **S8** The callback refuses a connection that is revoked or whose current secret
  version differs from the row's.
- **S9** A code is exchanged once and never retried. A provider `error` exchanges
  nothing: `access_denied` lands on `denied`, `server_error` and `temporarily_unavailable`
  on `provider_unavailable`, anything else on `token_refused` with the service's `error`
  code when it is at most 64 of `[a-z_]`. The service's `error_description` is never stored
  or shown. Tokens already held stay in force, so a cancelled reconnect breaks nothing.
- **S10** Exchange and commit don't use the request's signal, so closing the tab
  doesn't lose a consumed code.
- **S11** Every callback answer has `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`, and clears the cookie once the row is consumed.

**Redirect URI**

- **S12** The redirect URI is `PUBLIC_WEB_ORIGIN` + `OAUTH2_CALLBACK_PATH`, never
  from a request. The web form derives the same value from the same constant, and
  responses carry the server's value.
- **S13** The callback bypasses nginx logs: a Caddy `handle` as for `/v1/auth/*`,
  since its query holds a code and state; an install with nginx in front turns off that
  location's access and error logs. Nothing logged or traced contains them.

**Addresses**

The contract checks shape (S14). One function in the API process decides the rest
(S15) at create, replace and start; start also asks where the token address resolves.

- **S14** Refused by shape: anything but `http:`/`https:` (including `javascript:`),
  credentials, a fragment, over 2,048 bytes, reserved parameters already in the query.
  All settings together are at most 16,000 bytes, so what the contract accepts fits the
  database's 16,384.
- **S15** With `HTTP_ALLOWED_PRIVATE_NETWORKS` empty, refused: `http:`; every IP
  literal; `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.intranet`, `*.lan`,
  `*.home.arpa`; single-label names. With networks set, an IP literal passes only inside
  them, and names are settled at dispatch, with one exception: the authorization URL is never
  dispatched (S16), so it needs https unless it is such a literal or a local name above.
  Always refused: the hostname of `PUBLIC_WEB_ORIGIN`, whatever the port. The answer is
  `connection.oauth2_endpoint_refused`, naming the field. Start also resolves the token
  address under S17's rules and refuses it the same way, so a blocked address fails before
  a code is spent; a name that doesn't resolve there is left to the token request.
- **S16** Pertexo's server never requests the authorization URL; only the person's
  browser does, so its redirects aren't followed by us.
- **S17** Token requests go through `SecureHttpClient` with an address policy always
  passed (empty when no networks are set), because the transport only refuses plain
  http to a public address when a policy exists. Both API and worker read
  `HTTP_ALLOWED_PRIVATE_NETWORKS`. Every dispatch re-resolves and rechecks, so DNS
  rebinding and metadata addresses stay refused, including a metadata address carried
  inside IPv6 (mapped, translated, NAT64, 6to4), however wide the operator's networks.
- **S18** Token requests use `maxRedirects: 0`: any redirect from the token address
  is a failure, and the secret never follows one.

**Secrets**

- **S19** The client secret is sealed in `connection_secret_versions`; tokens are
  sealed in their own row with the same envelope. The authenticated data binds
  workspace, connection and the row's id, so a ciphertext copied to another row or
  connection won't open.
- **S20** The secret, tokens, code, state, verifier and binding appear in no API
  response, connection event, audit fact, log line, trace, step output or error
  summary. The two necessary exceptions: the state is in `authorizationUrl`, which the
  person must open, and the binding is in its own `Set-Cookie`. Token requests pass the
  secret, code and verifier as `sensitiveValues`. A refresh token isn't one: a service
  that doesn't rotate echoes it, and redacting that answer would store a broken copy.
- **S21** The PKCE verifier isn't stored: it is
  `deriveJourneySecret(applicationSecret, 'oauth2-pkce:' + state)`, the identity
  journeys' existing way. That function lives in the API, so `consent.ts` names the
  purpose and the API derives it.
- **S22** Changing any setting requires the client secret in the same request, so
  someone with manage rights can't point a stored secret at their own token address.
- **S23** Client ID, addresses, scope and parameters aren't secret and are returned
  to anyone who can read the connection.
- **S24** A token goes only to a host its connection allows. `*.example.com` matches
  subdomains, not the apex. Checked before dispatch; a cross-origin redirect is
  already refused because the request carries sensitive values.

**Size limits**

- **S25** A token response over 65,536 bytes fails. `access_token` is 1–8,000
  printable ASCII chars; `refresh_token` at most 16,384, and null or empty counts as
  absent. Others are ignored and `id_token` is never stored.
- **S26** `token_type` must be `bearer` in any case, or absent (null counts as absent).
  Anything else fails as an invalid response.
- **S27** A token response must be JSON. `Accept: application/json` is always sent.
  An `error` field means failure even with status 200 (GitHub does this).

**Isolation**

- **S28** Each new table has forced row security with the three policies of migration
  0051. Another workspace's id gets 404 on the start route.

## Token lifecycle

| Constant | Value |
|---|---|
| Renew when the token expires within | 60 s |
| Token request timeout | 15 s |
| Refresh block while one is in flight | 45 s |
| Block after a temporary failure | 15 s, or `Retry-After` in seconds, 1 to 60; a date or 0 counts as absent |
| Wait for another worker's refresh | 20 s, checking every 250 ms |
| Token too young to be rejected | 60 s since issue |
| Commit attempts | 3, 1 s apart |

### Getting a token

`accessToken(scope, signal)` in `packages/integrations/src/oauth2/access-token.ts`.
Expiry is read through database time and judged in TypeScript. Worker and API
connection tests share it.

1. Read the connection, client and token row, and record the credential access once.
   Not active, or no token row: fail with `http.oauth2_not_connected`.
2. Not due: open and return.
3. Due, not renewable: if expired, lose the grant with
   `connection.oauth2_token_expired`; if not yet, return it.
4. Claim: `UPDATE … SET refresh_blocked_until = now + 45 s WHERE id = <version read>
   AND (refresh_blocked_until IS NULL OR refresh_blocked_until <= now)`.
5. Claim lost, token not expired: return the current token. Expired: re-read every
   250 ms until the version changes or the block lifts, then start again; after 20 s
   fail with `http.oauth2_refresh_busy`.
6. Claim won: request the token, then branch on the table below. Step 4 opens the tokens
   and client secret before it claims, so nothing but the token request stands between a
   claim and its answer.

### Rules

- **L1** Two workers needing the same refresh make one token request; both then use
  the new token. The 45 s block outlasts the 15 s request, because secrets are opened before
  the claim, and it is set again before each seal and commit, because the service may
  already have rotated. Only a process frozen past the block can break this (L8).
- **L2** Every write that replaces or removes tokens is conditional on the version it
  read. A loser writes nothing and starts again.
- **L3** Before losing a grant to `invalid_grant`, the same check applies: if the
  version changed, someone else renewed it, so use theirs. This is what stops a late
  rotation race from breaking a healthy connection. With reuse detection a second call
  would revoke even the winner's tokens, which is why L1 keeps it from happening at all.
- **L4** A refresh isn't tied to the step's signal. Canceling a step lets the request
  and commit finish, because the provider may already have rotated.
- **L5** A response with no `refresh_token` keeps the stored one (RFC 6749 §6). One
  with a new one replaces it. Consent does the same under an unchanged secret version,
  since some services give a refresh token only on first consent; the cost is that a reconnect
  as another account, on a service that gives none, renews as the old account. Client
  credentials has no refresh token: renewing is a new token request, so it is always
  `renewable`.
- **L6** `expires_in` is a positive integer or numeric string up to 315,360,000, and
  anything else counts as absent. Expiry is commit time plus it, by database time. No
  expiry means no scheduled renewal.
- **L7** A connection is `active` exactly when it has a token row for its current
  secret version. Only `connections/oauth2` repositories, rotate, revoke and a workspace
  deletion request change this, each in one transaction. The first three take the workspace
  lock, then the connection row; a deletion request holds the workspace row and removes every
  token and pending row in the workspace, so nothing waits out the recovery window and a
  restored workspace reconnects. A consent answered during that request is discarded.
- **L8** Sealing and committing after a failure retry up to 3 times together with the
  tokens held in memory, then zero them. If it still fails, or the process dies first, a rotating provider
  answers `invalid_grant` next time and the connection shows reconnect. That window
  is accepted: no design closes it, it needs a crash within milliseconds, and it costs
  one visible reconnect. A second window is accepted the same way: if the worker told
  `invalid_grant` acts before the winner commits, L3's version check passes and the
  winner's commit is discarded. It takes a process frozen past the 45 s block, closing it
  would need a lock across HTTP, and it ends in a visible reconnect with L7 intact.

### What the token address answers

Failure codes are in `oauth2ConnectionErrorCodeSchema` and `oauth2StepFailureCodeSchema`.

| Answer | Connection | Step code | Step outcome |
|---|---|---|---|
| Valid JSON with a token | Stays active, `lastHealthyAt` set | — | Continues |
| `invalid_grant`, `interaction_required`, `consent_required`, `bad_refresh_token` | `connection.oauth2_grant_revoked`; tokens deleted | `http.oauth2_grant_revoked` | failed, authentication |
| `invalid_client`, `unauthorized_client`, `invalid_scope`, `unsupported_grant_type`, `incorrect_client_credentials` | `connection.oauth2_client_rejected`; tokens deleted | `http.oauth2_client_rejected` | failed, authentication |
| 429 | Unchanged; blocked for `Retry-After` | `http.oauth2_token_rate_limited` | retry, rate_limit, with that delay |
| 5xx, `server_error`, `temporarily_unavailable`, network, DNS, timeout | Unchanged; blocked 15 s | `http.oauth2_token_endpoint_unavailable` | retry, provider |
| Redirect, over limit, not JSON, no usable token, other 4xx, unknown `error` | Unchanged; blocked 15 s | `http.oauth2_token_response_invalid` | retry, provider |
| Address refused by SSRF rules | Unchanged | `http.oauth2_token_address_blocked` | failed, configuration |

**L9** A temporary failure while the token is still valid isn't a failure: the step
uses the valid token. Once it has expired, the step retries. **L10** Only the
two refusal rows change the connection; an outage never does. An unknown `error` stays
temporary, but its code is shown when it is at most 64 of `[a-z_]`.

A step's terminal failure with any of these codes takes its failure route, under the
error kind above. Every failure here has `possiblyDispatched: false`, because the service's
API was never called. A retried attempt whose dispatch is unresolved stays `outcome_unknown`
for non-repeatable methods, through the existing branch in `resolveRequestConnection`.

### Step failure text

| Code | `errorSummary` |
|---|---|
| `http.oauth2_not_connected` | "This connection isn't connected. Reconnect it in Connections." |
| `http.oauth2_connection_revoked` (failed, authentication) | "This connection was revoked. Choose another connection for this step." |
| `http.oauth2_grant_revoked` | "The service no longer accepts this connection's sign-in. Reconnect it in Connections." |
| `http.oauth2_client_rejected` | "The service refused the client ID or secret. Replace them in Connections, then reconnect." |
| `http.oauth2_token_expired` | "The access token expired and the service gave no way to renew it. Reconnect it in Connections." |
| `http.oauth2_token_rate_limited` | "The service's token address asked Pertexo to slow down." |
| `http.oauth2_token_endpoint_unavailable` | "The service's token address didn't answer." |
| `http.oauth2_token_response_invalid` | "The service's token address gave an answer Pertexo can't use. Check the token URL." With the service's code when it gave one: "The service's code: `<code>`." |
| `http.oauth2_token_address_blocked` | "The token URL points to a private or blocked address." |
| `http.oauth2_refresh_busy` | "Another step is renewing this connection's token." |
| `http.oauth2_host_not_allowed` (failed, configuration) | "This connection can't send its token to that host. Change the URL or the connection's allowed hosts." |

### When the API answers 401

- **L11** GET or HEAD: discard the body unstored, mark the token rejected, get a token
  again, and dispatch the same request once with it.
- **L12** POST, PUT, PATCH, DELETE: mark the token rejected and fail as a 401 does
  today (authentication, `possiblyDispatched: true`, response facts kept). **They are
  never dispatched a second time, whatever the answer.** The next attempt started by
  a person or a run picks up the new token.
- **L13** Marking sets expiry to now, only if the version matches, the token is
  renewable, and it was issued at least 60 s ago. Otherwise it does nothing and a GET
  fails without repeating. So an endpoint that always answers 401 can't drive refreshes.
- **L14** After a repeat, a second 401 fails. In a paged request, a later page may
  renew again only after a 2xx since the last renewal. Dispatch evidence is marked once.
- **L15** A 401 or 403 from an API never changes the connection, and 403 never renews.
  A builder pointing a step at any 401 URL mustn't break a connection for everyone.
  Only the token address changes its state.
- **L16** Replacing the token leaves `secretVersionId` unchanged, so fences and dispatch
  bindings of in-flight attempts stay valid. Replacing settings changes it, and those
  attempts fail before dispatch, as today.

### Connection tests

Same route, same `{ url }` body (HTTPS only), `connection:use`. Gets a token through
`accessToken`, GETs the URL, and applies L11 once. Outcome codes:

| Situation | `errorCode` | `reauthorizationRequired` |
|---|---|---|
| Not active | Its current code; no network | false |
| Host not allowed | `connection.oauth2_host_not_allowed`; no network | false |
| Token address temporary failure | `connection.provider_unavailable` or `connection.provider_rate_limited` | false |
| Token address unusable answer | `connection.provider_invalid_response` | false |
| Token address `invalid_*` | The connection's new code; the status has already changed | false |
| API 401 or 403 after any renewal | `connection.credential_rejected` | **false** (differs from header connections, per L15) |

Copy for that last row: "The API refused this token." / "It answered 401 or 403. Check
the scope and that this account can reach that URL, or reconnect."

## Storage

Rules live in TypeScript. PostgreSQL holds the rows, the checks below, and the conditional
updates. No SQL function. One migration, next free number:

```text
connection_oauth2_clients                 -- immutable, one per secret version
  workspace_id, connection_id, secret_version_id   PK
  settings jsonb NOT NULL                 -- oauth2ClientSettingsSchema; octet_length <= 16384
  created_at
  FK (workspace_id, connection_id, secret_version_id)
     -> connection_secret_versions ON DELETE CASCADE

connection_oauth2_tokens                  -- exists exactly when connected
  id uuid PK                              -- the version; new on every write; authenticated data
  workspace_id, connection_id             UNIQUE
  secret_version_id
  kms_key_reference, encrypted_data_key, ciphertext, nonce, auth_tag   -- NOT NULL, same checks as secret versions
  authorized_at, issued_at                -- NOT NULL
  access_token_expires_at                 -- NULL: the service gave no lifetime
  renewable boolean NOT NULL
  refresh_blocked_until                   -- NULL: free to claim
  FK (workspace_id, connection_id, secret_version_id)
     -> connection_oauth2_clients ON DELETE CASCADE

connection_oauth2_authorizations          -- at most one pending per connection
  workspace_id, connection_id             PK
  state_digest bytea NOT NULL, octet_length = 32, UNIQUE (workspace_id, state_digest)
  binding_digest bytea NOT NULL, octet_length = 32
  started_by uuid NOT NULL, secret_version_id, expires_at NOT NULL
  FK (workspace_id, connection_id, secret_version_id)
     -> connection_oauth2_clients ON DELETE CASCADE
  FK (workspace_id, started_by) -> workspace_memberships ON DELETE CASCADE
```

- **D1** Sealed JSON for tokens: `{ accessToken, refreshToken? }`. Sealed credential:
  `{ type: 'oauth2', clientSecret }`. Both formats live in `integrations/oauth2/stored.ts`.
- **D2** Also widen: `connections_auth_type_valid` with `oauth2`; `connection_events_type_valid`
  with `connection.oauth2_authorized`. Refreshes write no event: only transitions do, or an
  active connection grows a row an hour forever.
- **D3** Row security as S28, with app role `SELECT, INSERT, UPDATE, DELETE` and maintenance
  `SELECT, DELETE`, following 0051.
- **D4** Create inserts connection, secret version and client in one transaction, with status
  `reauthorization_required`. Replace inserts a new version and client, deletes the token and
  pending rows, and sets `reauthorization_required` with `connection.oauth2_not_authorized`.
  An OAuth2 connection can't become a header one or the reverse, as rotation refuses type
  changes today.
- **D5** Consent or client-credentials success in an active workspace: replace the token row (L5), status active, clear
  `lastErrorCode`, `healthRevision + 1`, source `rotation`, `lastHealthyAt` now, event
  `connection.oauth2_authorized`, audit fact. A refresh updates only the token row and
  `lastHealthyAt`.
- **D6** Losing a grant: delete the token row, status and code, `healthRevision + 1`, event
  `connection.reauthorization_required`, source `run` from a worker and `test` from a test.
- **D7** Revoke and a workspace deletion request delete token and pending rows in their
  transaction. The sealed client secret stays with its secret version, as for every connection,
  until workspace purge.
- **D8** Retention: no sweep. Pending rows are bounded by one per connection and replaced on
  the next start. Workspace purge removes all three through the cascade from secret versions.
- **D9** Backup holds sealed rows only. A restored backup may hold a refresh token the provider
  has since rotated: the next refresh gets `invalid_grant` and shows reconnect, which is safe.
  The runbook says so.
- **D10** Key rotation: `keys.repository.ts` adds tokens to its inventory as kind `connection`,
  `resourceId` = connection id, `secretVersionId` = token row id, so `verifyStoredEncryptionKeys`
  needs no change and startup refuses if a token's key is gone. Each refresh re-seals with the
  current key. No new environment key is needed.
- **D11** Promotion and portability never copy tokens. Slot checks move to one rule,
  `connectionFitsSlot` (below). Promotion also requires the target's auth type to equal the
  source's.

## Owners

| Path | Owns |
|---|---|
| `packages/contracts/src/schemas/oauth2-connections.ts` | The settings, credential, response and code enums; see Contract below |
| `packages/workflow-model/src/authoring/connections/` | `oauth2` in `CONNECTION_AUTH_TYPE`; `connectionFitsSlot({ providerKey, authType }, slot)`: same provider and same type, or slot `http_headers` with type `oauth2` |
| `packages/database/src/schema/oauth2-connections.ts`, `migrations/` | Tables above |
| `packages/database/src/connections/oauth2/` | `contract.ts`, `clients.repository.ts`, `authorizations.repository.ts`, `tokens.repository.ts`; implements the store below |
| `packages/database/src/platform/encryption/keys.repository.ts` | D10 |
| `packages/integrations/src/oauth2/contract.ts` | The store port: database implements it, since integrations may not import database |
| `packages/integrations/src/oauth2/stored.ts` | D1 |
| `packages/integrations/src/oauth2/endpoints.ts` | S15 |
| `packages/integrations/src/oauth2/token-endpoint.ts` | The three token requests, S17–S18, S25–S27, and the answer table |
| `packages/integrations/src/oauth2/consent.ts` | Authorization URL, state format, the verifier's purpose (S21) |
| `packages/integrations/src/oauth2/access-token.ts` | `accessToken`, `rejectToken`: the lifecycle above |
| `packages/integrations/src/oauth2/refresh.ts` | One renewal: claim, ask, commit with its three attempts, and what each answer does to the grant |
| `packages/integrations/src/http-request/execution/oauth2-renewal.ts` | Wraps the HTTP client for L11–L14, single and paged, and S24 |
| `packages/integrations/src/http-request/execution/oauth2-failure.ts` | The step failure class and text, like `HttpPaginationFailure` |
| `packages/node-sdk/src/execution/contract.ts` | Adds optional `resolveHttpCredential` and `rejectAccessToken` to `NodeConnectionRuntime`, as `assertCurrent` is; only an HTTP step needs them. The first returns a union on `authType` (`http_headers` with `secret`, `oauth2` with `accessToken`, `tokenVersionId`, `requestHosts`) |
| `apps/worker/src/providers/connections.ts` | Implements both behind the existing provider rate limit; `assertCurrent` allows `oauth2` |
| `apps/worker/src/attempts/execution/capability-composition/connections.ts` | Gives it the token service and HTTP client |
| `apps/api/src/connections/oauth2/` | `controller.ts`, `start-authorization.ts`, `finish-authorization.ts`, `errors.ts`; registered in `module.ts` |
| `apps/api/src/connections/use-cases/` | Create, rotate and test branches (`testing/oauth2.ts`); `problems/resources/connections.ts` |
| `apps/api/src/platform/connections/runtime.module.ts` | A second secure client with the address policy for token requests only |
| `apps/web/src/features/connections/` | `credential-draft.ts` union, `components/credential/oauth2-fields.tsx`, `components/oauth2/connect.tsx`, `hooks/use-oauth2-consent.ts`, `data/oauth2.api.ts`, `pages/oauth2-finished.tsx`, and the copy in `model/` |
| `apps/web/src/routes/root/` | The landing route, public |
| `infrastructure/single-server/` | Caddy `handle` (S13); `HTTP_ALLOWED_PRIVATE_NETWORKS` for the API; `.env.example`; runbook note (D9) |
| `CONTEXT.md`, `docs/guides/` | The term **OAuth2 grant**; a short guide |

Routes use `provider_test` for start, `identity_callback` for the callback.

**Later, not now:** the target design moves `access-token.ts`, `consent.ts` and
`connections/oauth2/*` into `core/connections`, and the envelope and `SecureHttpClient`
into `secrets`. `token-endpoint.ts` and `endpoints.ts` stay in `integrations`.

## Contract

In `packages/contracts`, with artifacts regenerated: `schemas/oauth2-connections.ts` (settings,
credential, response, start response, callback query and landing, and the connection and step
code enums), and `startConnectionOAuth2Authorization` and `completeConnectionOAuth2Authorization`
in `openapi/connections.ts`. The `http` member of `connectionCreateRequestSchema` takes either
credential; there is no separate create route. `connectionResponseSchema` is a union of the other
auth types' shape and `oauth2ConnectionResponseSchema`.

Problem codes: `connection.oauth2_endpoint_refused` (400, with the field in `errors`),
`connection.oauth2_token_refused` (409, a client-credentials start that the service refused). An
outage on start is the existing `provider.unavailable`; starting on a revoked connection is
`connection.revoked`; on a non-OAuth2 connection is `connection.conflict`.

## Not in this slice

A provider catalog or presets (next slice); polling and triggers; other grants (implicit,
password, device); public clients with no secret; `private_key_jwt`, mTLS, DPoP, PAR; OpenID
discovery and `id_token` checks; provider-side revocation; proactive background refresh;
"ignore TLS errors" (never); OAuth2 for anything but HTTP Request.

## Proof required

Write these from this plan. Mock only outside services, and the stand-in below replaces those.
Existing HTTP executor stubs (`packages/integrations/test/support/http-execution.ts`,
`pagination.ts`, and a few others) gain `resolveHttpCredential`. That change has a reason here
and loosens no assertion.

**Stand-in:** `infrastructure/testing/oauth2-stand-in.mjs`, a real HTTP server on 127.0.0.1 with
`HTTP_ALLOWED_PRIVATE_NETWORKS=127.0.0.1/32`. It has `/authorize` (Approve and Deny buttons),
`/token`, and `/api` (checks the bearer token, counts calls). It records every request. Each
client ID selects behavior: rotating refresh tokens **with reuse detection that revokes the whole
family**; rotating without it; non-rotating; no refresh token; no `expires_in`; delayed; 503; 429 with `Retry-After`;
`invalid_grant`; `invalid_client`; `error` with status 200; each provider-specific refusal in the
answer table; a refresh token only on first consent; null fields; a date in `Retry-After`; a redirect; an oversized body;
non-JSON; a `token_type` of `mac`; `/api` always 401; `/api` 401 once.

**Contract** — schemas accept and refuse per S14, reserved parameters and limits; the callback
query takes a code or an error, never both and never a repeated parameter; responses can't hold
a secret; an active response must have `grant` and others can't.

**Address and token rules, real HTTP** — each of S15 with networks empty and set; a token address
redirect fails with the secret sent nowhere else, seen at the redirect target; a hostname resolving
to a private or metadata address is refused at dispatch (S17); plain http to a public address is
refused even with no networks set; S25–S27 each; basic and body authentication send what the stand-in
expects, including a secret with `+` and `/`; extra parameters reach the right request.

**Database, real Postgres** — S28 and D3: app role in workspace A can't read or write B's rows in
all three tables; S4 with concurrent consumers: one wins; the L2/L3 version checks; L7 holds after
each scenario in this list; a ciphertext copied to another connection won't open (S19); D7; D8 with a
real workspace purge leaving no rows; D10 counts token keys and startup refuses when one's key is gone;
migration on a database with existing connections leaves them unchanged.

**API, real Postgres and stand-in**

- Roles: viewer can't start, builder and operator can't start, admin and owner can; another
  workspace's id gets 404; start needs CSRF.
- A restricted connection honors sharing in a run and test.
- Callback refusals all land `invalid` and exchange nothing (the stand-in's count stays 0): no cookie,
  wrong cookie (and the row survives for the right browser), tampered workspace, replay, expired,
  replaced by a newer start, starter demoted, starter removed, connection revoked mid-consent, settings
  replaced mid-consent.
- `access_denied` lands `denied` with tokens kept; a reconnect that is denied leaves an active
  connection working.
- Redirect URI equals S12's value in both the start URL and the exchange. PKCE: the verifier matches
  the challenge; off sends neither.
- S20: after a full journey and a failed one, search every response, connection event, audit row,
  captured log line and trace attribute for the known secret, tokens, code, state and verifier.
- D4, D5, D6 transitions, with `secretVersionId` unchanged by a refresh.
- S22: replacing settings without the secret is refused; replacing drops tokens and asks for consent.
- Test route rows in the table above, including L15: a 401 from the test URL leaves the status active.

**Step behavior, real worker, Postgres and stand-in**

- A published workflow's HTTP Request reaches `/api` with `Bearer <token>`, and the token isn't in its
  stored output.
- Expired and within-60-seconds tokens renew first; a fresh token makes no token request.
- **L11**: GET and HEAD with 401-once succeed, with exactly 2 `/api` calls and 1 token request.
- **L12, per method: POST, PUT, PATCH and DELETE with 401-once produce exactly 1 `/api` call, a failed
  step, and a token marked for renewal. This is the proof that a retry never repeats a side effect.**
- L13: an always-401 GET makes at most one renewal per 60 s. L14: a paged GET with 401 on page 3
  completes with no repeated page other than page 3, and dispatch evidence marked once.
- L15: after any 401 or 403 the connection is still active.
- L16: a step retried across a refresh keeps its dispatch binding.
- S24: a listed host passes, an unlisted one fails with no `/api` call, `*.` doesn't match the apex.
- L9: 503 with a valid token succeeds; with an expired one retries, status stays active, then recovers
  once the stand-in does. Each row of the answer table gives its code and connection state.

**Worker race, real processes and Postgres**

- Two worker processes with an expired token against rotating-with-reuse-detection: exactly one token
  request, both steps succeed, active.
- Late rotation (L3), against rotating without reuse detection: delay the first request and clear
  `refresh_blocked_until` directly in the database so the second worker also calls. The stand-in answers
  the first with new tokens and the second `invalid_grant`. The connection stays active and both steps
  succeed.
- The reverse commit order, with the second requester answered and committed first, gives the same
  result. If the worker told `invalid_grant` acts before the winner commits, it ends in a visible
  reconnect with L7 intact (L8).
- A person reconnects during a refresh: the refresh's commit is discarded, and the new grant stands.
- L4: cancel a step during a delayed refresh; the new tokens are still committed.

**Faults, in the fault suite**

- `SIGKILL` the worker while it holds a block on a non-rotating token: after 45 s another worker renews;
  no run stays stuck.
- `SIGKILL` between the token response and commit on a rotating token: the next use gets `invalid_grant`,
  shows `connection.oauth2_grant_revoked`, step code visible; reconnect restores it.
- Restart Postgres during commit: L8 commits on a later attempt or, after three, the connection ends in
  a visible state, never active with a token that doesn't work and never a stuck run.
- Redis down during `resolveHttpCredential`: the existing provider rate limit behavior applies.

**Real browser journey, `apps/web/e2e-live`, against the real stack and stand-in**

1. Owner adds an OAuth2 connection; the form shows the redirect URL; the connect step names both hosts.
2. Consent window opens, Approve, it closes or shows "Connected. You can close this tab."; the first tab
   moves on with no reload.
3. Publish and run an HTTP Request with it; the run succeeds.
4. The stand-in revokes the grant; the next run whose token is due for renewal fails with the
   `http.oauth2_grant_revoked` text (with a fresh token, the API's 401 changes nothing, per L15); the
   connection shows "Needs reauthorization" and the notice; Reconnect, Approve; the same workflow runs
   again without being edited.
5. Deny shows the `denied` text and changes nothing.
6. A New HTTP sheet from the editor keeps an unsaved draft through consent and selects the connection.
7. A blocked window shows **Open sign-in page**, which works.
8. Viewer and builder see no Connect or Edit settings; a builder can pick it and test it.
9. Phone-sized viewport for the form and landing page.

Mocked browser tests cover each notice, landing result and failure text exactly as written above.
Every fix ships a test that failed without it.

## Proof only a real provider can give

The owner runs these later with sandbox apps. They can't be done here:

- **Google:** `access_type=offline` and `prompt=consent` give a refresh token; a test app's 7-day
  refresh expiry gives `invalid_grant`.
- **Microsoft Entra:** rotating refresh tokens in practice; admin-consent errors; token sizes
  against the 8,000 limit.
- **A provider with reuse detection (Auth0 or Okta):** a real race, and its grace window.
- **GitHub OAuth App:** `error` with status 200; no `expires_in`.
- **A real internal IdP behind `HTTP_ALLOWED_PRIVATE_NETWORKS`.**
- **Real Safari, iOS Safari and Firefox:** window opening, `opener` clearing, `window.close()` and
  `BroadcastChannel` (none are checked by anyone yet).

## Delivery tracker

- [x] Plan and contract.
- [x] Tests, by a separate agent, from this plan.
- [x] Code, by a separate agent.
- [x] Real browser journey and fault suite green.
- [ ] Sandbox proofs (owner).

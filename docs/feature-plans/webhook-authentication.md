# Webhook authentication modes

Status: implemented and locally qualified. Updated: 2026-10-17. Decision: [ADR 026](../adr/026-generic-webhook-signature-replay.md).

## Current code and outcome

`api/webhooks/ingress` authenticates exact JSON bytes with Pertexo HMAC.
Materialized endpoints hold a hashed address and current/previous encrypted
32-byte secrets. `database/triggers/webhooks` owns management, endpoint fences,
60/minute ingress allowance, delivery history and transactional admission.
`workflow-settings` owns the once-only credential reveal and uncertain command
retries. Extend these owners; no graph authentication settings, new service,
role, dependency or CI job. Respond to webhook retains its worker capability
and durable multi-instance response record.

## Decisions and rules

- Existing and newly provisioned endpoints default to **Signed**. Preserve its
  exact timestamp/raw-body contract and five-minute secret overlap.
- Add **Secret URL** and **Header secret** to endpoint settings. URL mode needs
  only the existing random 256-bit address, never decrypts a signing secret,
  and explains that anyone possessing the URL can invoke it. Header mode uses
  the existing encrypted random secret, base64url encoded, in `Authorization:
  Bearer …` or one configured HTTP header. Reuse the existing 32-byte envelope
  and once-only `signingSecret` wire field; the editor labels it **Header secret**.
  Compare the fixed-size encoded credentials in constant time. Refuse ambiguous duplicate/comma-folded authentication headers.
- One shared contract validates mode, safe header name and at most 20 distinct
  exact HTTP(S) origins (scheme, host, optional port; no credentials, paths,
  wildcard or opaque `null`). Header names use lowercase letters, digits and
  hyphens, bounded to 64 characters; transport, proxy, cookie, CORS, content, tracing and Pertexo
  protocol headers cannot be credentials. Authorization is explicitly allowed.
- Configuration is an authorized, CSRF-protected idempotent command. Changing
  mode or credential header rotates **both** URL and secret immediately and
  clears previous-secret overlap: an old address must not become a newly weaker
  credential. Show fresh credentials once, exactly like existing rotation.
  Changing only browser origins preserves credentials. Lost responses resolve
  as completed without redisclosing secrets; rotate again if necessary.
- Explicit URL rotation still invalidates the old URL immediately; same-mode
  signing/header-secret rotation retains the existing five-minute overlap.
  Secret rotation in URL mode is unavailable in the UI and refused by storage.
- Recheck endpoint identity, authentication settings and eligible credential
  under the admission transaction's existing locks, including exact retries.
  A concurrent mode/origin/credential change cannot admit using stale proof.
  Preserve raw-byte deduplication and TTLs in every mode. Delivery history keeps
  its existing `signatureCheck` wire/storage name, labeled **Authentication** in
  the UI; `verified` means the configured mode authenticated the request.
- Browser origins are optional, default empty, and available only in URL/header
  modes. OPTIONS verifies endpoint, exact Origin, POST and an explicit supported
  request-header set; returns 204 without decrypting, admitting a run or creating
  a delivery or allowance write. Preflight is a bounded endpoint lookup, so
  browser callers retain the same 60 POST attempts/minute as server callers.
  Unsupported endpoints/origins/preflights share the authentication failure.
- For URL/header POST with Origin, reject unlisted origins before acceptance.
  Requests without Origin remain server-to-server. Only configured origins receive
  `Access-Control-Allow-Origin`, on accepted 202, workflow replies and attributed
  errors; append `Vary: Origin`. Never send Allow-Credentials or wildcard lists.
  Preflight allows Content-Type, Idempotency-Key and the configured credential
  header, with no preflight cache lifetime, so changing settings takes effect.
  No global API CORS or new browser session authentication is introduced.
  This follows the [Fetch CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol).
- Keep URL credentials and arbitrary credential-header values out of logs and
  telemetry. Do not capture request headers/body. Redact `/hooks/<key>` paths.
- Respond to webhook adds `text/csv` and `application/xml` as explicit text
  formats; default remains text/plain. Permit the current named safe headers
  and bounded custom `x-` headers, excluding proxy/forwarding, security/CORS,
  content-type override and other reserved response-control headers. Maximum
  16 headers, 1,024 ASCII characters/value. Header names are case-insensitive,
  normalize to lowercase and refuse duplicates. Keep HTML, cookies, redirects,
  hop-by-hop headers, generated nosniff/no-store and the 1 MiB response bound.

## Structure and slices

| Owner | Change |
| --- | --- |
| contracts/triggers | Authentication policy schema and management/OpenAPI contract |
| database/schema/triggers + triggers/webhooks | Policy column, narrow resolver projection, transactional configuration/fences |
| api/webhooks/authentication | Header authentication and endpoint-scoped CORS helpers |
| api/webhooks | Existing ingress and management orchestration |
| node-sdk + nodes-core/flow/respond-webhook | Shared response header rule, text MIME choices |
| web/workflow-settings | Mode/origin form, uncertain retries, reveal and mode-specific sender guide |
| web/workflow-editor | Existing response setup with text format picker |
| observability | Credential-address sanitization |

One PR after F02: plan/ADR, storage/API, editor/docs and qualification. No moves
are planned. Required moves, if discovered, remain separate buildable commits.

## Verification and status

Qualified locally on 2026-10-17: root build/lint/types/dependency/contracts/schema/
boundary checks; 9,471 unit tests; 196 mocked browser tests; 26 PostgreSQL tests
including populated upgrades; 10 real HTTP tests; two browser/API/worker journeys.
The latter preserve the original Signed flow and author a CSV reply, configure
URL mode at 375px, prove validation focus, make a real browser CORS request,
verify exact reply bytes/custom headers/deduplication and reject the old URL.
Desktop and phone renders were inspected. React Doctor: 100/100 across all 14
changed frontend files, no warnings or suppressions. Actual HTTP/Undici span
exports also exclude URL credentials, named-header secrets and Bearer values.

The accepted plan and ADR amendments, storage/API, editor and docs are complete.
Green PR CI is required before rebase merge.

Later: F21 provider signatures; wildcard/credentialed browser access, HTML,
streaming and arbitrary binary responses remain out of scope.

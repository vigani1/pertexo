# F35 — Webhook test events

Owner-approved feature, 2026-10-20. This extends F02 samples and the existing
webhook ingress; it does not execute a workflow or introduce infrastructure.

## Decisions and rules

- **Listen for test event** opens a separate, unguessable `/hooks/<key>/test`
  address for 120 seconds. It accepts one real request. Production addresses
  keep working independently; test requests never admit runs, coordinate
  events, consume run slots, send webhook replies or create operational notices.
- Listening works on a saved draft before first publication. Its temporary
  credentials use the existing Signed (default), Secret URL or Header secret
  protocol and exact-origin CORS rules. The editor chooses the mode explicitly;
  test credentials are separate from production credentials and expire with the
  listener. Signed/header secrets are generated and shown once, encrypted with
  the existing webhook envelope. No new signing scheme or credential format.
- Only current editors can listen; only the initiating editor can inspect its
  temporary capture. Recheck their access,
  workflow lifecycle and the saved step's binding at capture/read. A changed
  setup requires a fresh listener. Stop/restart invalidates the old address.
  One listener per workflow, at most ten retained listeners per workspace.
- Authentication, freshness, body parsing, credential-header removal and input
  projection reuse production owners. Existing 256 KiB request and stored-value
  depth/item/byte bounds apply; oversized samples fail clearly. Unknown,
  expired, stopped and already-consumed test URLs have the same non-disclosing
  authentication failure. Bound attempts to 60 per listener; no unauthenticated
  payload is retained.
- PostgreSQL stores the short-lived listener and its first captured inline
  execution value. A row lock makes simultaneous requests choose exactly one
  winner across API instances. No in-process listener registry or waiting HTTP
  connection. Captured data expires after ten minutes; the existing retention
  worker deletes expired rows, and workflow/workspace deletion removes them.
- Local Vite forwards `/hooks` to its existing API proxy target, with credential
  paths and queries redacted from proxy-error logs. Vite does not add its own
  CORS headers or consume preflight; the API remains the owner. Production keeps the existing
  Caddy route; no new proxy service or public configuration.
- The editor polls only while waiting and visible. It shows waiting, captured,
  expired/stopped and setup-changed states, with Stop and Listen again. Closing
  the panel stops the listener on a best-effort basis; expiry is authoritative.
  Navigation/reload does not persist credentials in browser storage.
- **Keep as pinned sample** explicitly uses F02's existing sample command and
  its draft revision / expected-sample fences. It never overwrites a pin merely
  because a request arrived. The pin has the usual shared visibility, quota,
  stale-binding rules and retention; export/import omits it. Captured body data
  can contain secrets: warn before listening and before keeping it.
- The captured output is exactly what the webhook trigger would produce for
  its saved `runInput` choice (body/query or sanitized full request). No extra
  sample shape, browser parser, raw request log or automatic workflow execution.

The temporary URL and credentials permit testing before production setup without
weakening the selected authentication mode. n8n uses a separate 120-second test
URL; Zapier captures a request in the trigger's Test tab; Make determines input
structure from a received sample. Pertexo keeps its existing authenticated
webhooks and explicit pin operation instead of silently retaining production
requests. Sources:
[n8n](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/workflow-development),
[Zapier](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zap-workflows-from-webhooks),
[Make](https://apps.make.com/gateway).

## Ownership and delivery

| Part | Owner | Status |
| --- | --- | --- |
| Bound listener, single capture, RLS, expiry and purge | database/triggers/webhooks/test-events; schema/triggers | Implemented |
| Temporary credentials, shared authentication/parsing, management endpoints | api/webhooks/test-events; existing ingress | Implemented |
| Listen/review/keep in trigger Test tab; normal F02 pin command | web/workflow-publish; editor composition | Implemented |
| Real API races/auth/lifecycle, browser journey, guide and roadmap | existing test suites and docs/guides/webhooks.md | Implemented |

Keep moves separate from logic. Verify strict types, lint, units, real PostgreSQL
and API ingress tests, mocked browser journeys and rendered desktop/phone states;
run the full pre-push hook. Cover all three auth modes and preflight, invalid
credentials, expired/stopped/consumed tokens, concurrent first requests, wrong
workspace/viewer/removed editor, changed setup, size/depth bounds and pin
conflicts. Prove test capture creates no run or production delivery and ordinary
webhooks are unchanged. Auto rebase-merge after green required CI.

Provider-specific signatures, request history, production traffic recording,
webhook files, tunnels and automatic execution after capture stay later.

## Qualification

2026-10-20: real API tests cover all authentication modes, actual before-publish
capture, two independent API listeners racing for one capture, preflight,
credential/proxy header stripping, bounds, the ten-listener quota, pinning,
changed/archived drafts, removed editors, viewers and another workspace. No run
or production delivery is created. The existing webhook journeys stay green.
The maintenance-role tests qualify paged expiry, workspace purge coverage and
key inventory. Browser journeys cover 375/1280 px, reduced motion, review and
explicit pinning; starting the listener brings its URL into view. A real Vite
proxy test checks POST bytes, API-owned OPTIONS and redacted outage logs.
Generated secrets stay out of Query/mutation caches. React Doctor reports no
introduced diagnostics. Full repository gates and pre-push remain required for
delivery; required GitHub CI controls auto rebase-merge.

## UX follow-up (2026-10-20)

Stopping a listener preserves its selected authentication mode, header name
and allowed origins while the panel stays open; generated credentials still
leave with the listener. Keeping a captured request uses the existing F02 pin
command with a webhook_test source and listener ID. The transaction reads the
exact captured output with actor/workspace/workflow/step, expiry and current
binding fences. The existing sample source discriminator records webhook_test
(with no retained listener ID or secret); confirmation preserves this provenance
after the listener expires. A JSON paste stays JSON. Existing pins whose origin
was discarded cannot be retrospectively identified as captures.

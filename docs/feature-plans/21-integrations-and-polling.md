# F21 — Provider expansion and durable polling/subscriptions

Generic OAuth2, SMTP, PostgreSQL actions, and HTTP and PostgreSQL polling are
on `main`. Broader native connectors and subscriptions remain open. See
[OAuth2](21a-oauth2-connections.md), [the delivery sequence](21b-next-integrations.md)
and the [product roadmap](../product-roadmap.md).

## Outcome

Complete a small set of real user automations with dependable provider actions and triggers instead of accumulating shallow connectors.

## Current implementation and evidence

HTTP Request, Slack messages, email, and manual, form, webhook, schedule,
workflow error and polling triggers are available. [F54](54-polling-triggers.md)
and [F55](55-database-row-trigger.md) define the implemented polling cursor
and trigger behavior. Native provider subscriptions remain future work.

See the [integration modules plan](57-integration-modules.md) for the current
provider structure and [the architecture guide](../architecture.md) for runtime
ownership.

## Dependencies and planning gate

Core usability/reuse waves first; 12 operational limits; explicit provider sandbox access.

Provider scopes, quotas, initial backfill, cursor expiration, deactivation on auth loss, credential ownership; OAuth registration and real calls need configured access.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Provider-specific integrations; catalog composition; connections/trigger application; database cursors/receipts; worker; web provider forms.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Provider catalog, connection scopes/reauthorization, operation-specific forms, sample events and sync/trigger health.

## Backend work

Existing SDK/catalog/integrations pattern; provider-specific idempotency/retry/error and credential lifecycle. Polling requires durable cursor, pagination/backfill policy, lease and atomic event-dedupe→run acceptance; subscriptions need verification, renewal and revocation.

## Delivery slices

0. **Generic OAuth2 connections for HTTP Request.** HTTP Request already
   accepts header credentials (`http_headers` connections), so most APIs work
   today. An OAuth2 connection type with authorization-code consent, encrypted
   token storage, refresh and reauthorization unlocks the rest (for example
   Google or Microsoft APIs) without a bespoke connector. Can ship before the
   provider slices; each later provider reuses it.
1. Rank requested end-to-end journeys and choose one provider, not a large arbitrary list.
   The proposed order is in [21b](21b-next-integrations.md).
2. Ship one action with real sandbox compatibility and safe connection UX.
3. Ship its highest-value trigger with crash/cursor/dedupe proof; repeat only when previous slice is usable.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Expired token, provider rate limit, duplicate pages/events, cursor advance crash, schema drift, subscription loss, secret redaction, retry safety and actual sandbox contract.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Broad integrations before core usability, generic one-policy provider executor, paid/provider provisioning without approval.

## Rollout and rollback

Stop scheduling affected provider, preserve accepted work and cursors, explicit user reconnect; do not erase failure history.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Breadth matters eventually, but cannot be responsibly matched by a connector count. User preference is core features first.

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

For delivered slices, see the linked plans. This checklist applies to future
provider work.

## Authorized SMTP email connection follow-up (2026-11-08)

Product-ux-15 adds an Email (SMTP) choice alongside Resend for the existing Send
email step and shared email failure alerts. Reuse the existing system SMTP
adapter, sealed connection secrets, outbound address policy and network
allowlist. Require explicit `SMTP_ALLOW_PLAINTEXT=true` for mode None and warn in
the form. The connection probe connects, requires the selected TLS mode,
authenticates and quits without sending a message. Actual sends report safe
sender-refusal diagnostics. Preserve unknown SMTP outcomes without automatic
resending. The server-mail destination is authorized separately in F09.

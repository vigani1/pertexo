# F16 — Scoped automation tokens, public API and CLI

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Backend security product + developer UX. Relative size: **L–XL**, not a calendar estimate.

## Outcome

Users manage approved workflow operations programmatically without scripting browser sessions.

## Current implementation and evidence

HTTP contracts/OpenAPI exist. API-key entities were deferred; cookie-session routes do not constitute a supported external automation token product.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [Reset tracker](../architecture-reset-plan.md)
- [packages/contracts/src/openapi/generated-artifacts.ts](../../packages/contracts/src/openapi/generated-artifacts.ts)
- [apps/api/src/workspaces](../../apps/api/src/workspaces)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

05 for portable workflows; existing public schemas; separate from browser sessions.

ADR for machine identity/authentication; personal tokens versus workspace service accounts; avoid expanding rights on membership changes.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Identity/machine-auth adapter and shared authorization use cases; database token lifecycle; contracts; web token settings; optional CLI consumer.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Create/revoke scoped token, one-time secret display, expiry/last-used metadata, examples and safe audit views.

## Backend work

Hashed high-entropy credentials, explicit actor/workspace scopes, rotation/revocation, rate limits and audit; shared use cases enforce capabilities for both browser and token adapters. Versioned SDK/CLI commands use the existing contract source.

## Delivery slices

1. Define permitted scopes, ownership, expiry and separation from cookie/CSRF flows.
2. Ship minimal token management plus list/read/run commands and generated examples.
3. Add import/export automation after 05; packaging/CLI only for documented operations.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Revocation/expiry, scope escalation, cross-tenant IDs, one-time secret display, rate limits, retries and redacted diagnostics.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Admin bypass tokens, storing raw keys, browser localStorage credentials, exposing every internal operator command.

## Rollout and rollback

Revoke new credentials and disable token authentication without affecting existing browser sessions.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Programmatic workflow operations are a mature-platform capability; protocol and scopes should follow our contracts, not competitor endpoints. Sources: [n8n source control and environments](https://docs.n8n.io/administer/use-source-control-and-environments).

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

Evidence log: none for this new plan. Existing foundations above are not completion
of the proposed increment. Mark genuinely inapplicable rows with a reason rather
than fabricating work.

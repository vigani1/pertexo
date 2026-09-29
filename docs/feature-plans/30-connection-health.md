# F30 — Connection health and reconnection

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-29. Parent: [product roadmap](../product-roadmap.md).
Scope: Extends existing connections. Relative size: **M–L**, not a calendar estimate.

## Outcome

People learn that a connection stopped working (revoked, expired or rejected
credentials) before more runs fail, see which workflows depend on it, and fix
it in one place.

## Current implementation and evidence

Connections record `lastTestedAt`, `lastHealthyAt` and `lastErrorCode`, and
people can test and rotate them. Health changes only when someone tests;
failing runs do not move a connection into an unhealthy state, and nothing
lists the workflows that use a connection.

Inspected anchors (paths may move):

- [packages/contracts/src/http/connections.ts](../../packages/contracts/src/http/connections.ts)
- [docs/adr/023-slack-send-message-provider.md](../adr/023-slack-send-message-provider.md)

## Dependencies and planning gate

None to start. F27 turns health changes into notices; F26 may pause workflows
whose connection is broken.

Resolve in an ADR before code:

- **Authoritative signals**: only provider responses that mean the credential
  is invalid (for example revoked or unauthorized) change health; timeouts and
  rate limits never do. One failed request is not enough unless the provider
  says so definitively.
- **States**: reuse the existing connection status `reauthorization_required`
  for credentials a provider rejects, beside test-derived health; transitions
  are recorded with time and a safe reason code, never provider error text or
  secrets.
- **Recovery**: a successful test or run restores health; rotation resets it.
- **Usage**: which published workflow versions reference a connection.

## Ownership and structure

Integrations error classification; database health transitions; worker
reporting from node attempts; contracts; web connections page.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).

## Frontend work

Health state and reason on the connections page and in workflow settings;
"used by" workflows; a reconnect or rotate action where needed.

## Backend work

Provider-specific classification of credential failures, bounded health
transitions from node attempts, a used-by projection, and a health-change
source for F27 notices.

## Delivery slices

1. ADR for signals, states and recovery.
2. Health transitions from runs with real-database tests; used-by projection.
3. UI, then notices once F27 exists.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

A revoked credential marks the connection broken once, despite concurrent
failing runs; transient errors never do; a successful test restores it; used-by
lists exactly the dependent published workflows; no secret or provider text is
exposed.

## Non-goals

Automatic credential refresh beyond what each provider's auth already does,
provider status pages.

## Rollout and rollback

Report-only first (record transitions, no UI state), then show; disabling
reverts to test-only health.

No production rollout, paid provisioning or real external calls are authorized
by this plan.

## Competitor context

Zapier marks expired app connections and offers a reconnect action that fixes
every Zap using them
([manage app connections](https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections)).

Research checked 2026-09-29; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation.

## Delivery tracker

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: none for this new plan.

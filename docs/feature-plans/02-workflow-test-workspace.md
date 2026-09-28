# F02 — Saved test cases, pinned samples and workflow regression runs

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New product over existing previews. Relative size: **L**, not a calendar estimate.

## Outcome

Developers can test a workflow repeatedly with named safe fixtures and explicit assertions without silently calling production systems.

## Current implementation and evidence

Node previews, test bar, recorded step inputs/outputs and run replay exist. No complete durable saved-case/pinned-sample product was established in inspected feature inventories.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/api/src/node-testing/use-case.ts](../../apps/api/src/node-testing/use-case.ts)
- [apps/web/src/features/workflow-runs/workflow-runs.api.ts](../../apps/web/src/features/workflow-runs/workflow-runs.api.ts)
- [apps/web/test/features/workflow-editor-test-bar.test.tsx](../../apps/web/test/features/workflow-editor-test-bar.test.tsx)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; pin policy approved before production data reuse.

ADR for durable preview overrides and effect isolation; choose assertion vocabulary, quotas and whether cases belong to draft or version. Do not label replay as resume.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Web workflow-testing/editor; application node-testing use cases; database test-case domain; contracts; preview execution adapters.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Named input fixtures, selected sanitized recorded samples, expected-output assertions, run results and a visible mocked/pinned badge. Preview execution with real effects requires an explicit distinction.

## Backend work

Workspace-authorized, bounded test-case persistence and version references; preview-only substitution policy bound to node/schema/scope, with an explicit adapter seam. Production acceptance rejects test overrides. Start with input fixtures before arbitrary mid-graph pinning.

## Delivery slices

1. Define case ownership, schema/version binding, sample retention and redaction; deliver named run-input cases.
2. Add node sample substitution with provenance and invalidation on relevant graph/schema change.
3. Add bounded batch regression and assertion results; expose comparisons without changing real run truth.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Pinned provider never dispatches; production rejects pins; stale schema cannot silently pass; cross-tenant sample denied; secret fields excluded; cancellation and bounded batch behavior.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Arbitrary assertion JavaScript, load testing as a feature and automatic production-data capture.

## Rollout and rollback

Disable new test commands; retain existing preview behavior and stored cases, clearly marked incompatible where necessary.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents development-only pinning/mocking. Pertexo should retain an equally explicit production/test distinction. Sources: [n8n pinning and mocking](https://docs.n8n.io/build/work-with-data/pin-and-mock-data).

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

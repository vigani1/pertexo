# F22 — AI authoring assistance, model nodes and controlled tools

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Later optional capability. Relative size: **XL**, not a calendar estimate.

## Outcome

AI can help draft valid workflows or perform explicit bounded model tasks without bypassing review or leaking workspace data.

## Current implementation and evidence

No complete AI authoring/model/tool product established in inspected core/integration catalogs. Do not equate an expression editor with AI automation.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [packages/nodes-core/src/definitions.ts](../../packages/nodes-core/src/definitions.ts)
- [packages/integrations/src/index.ts](../../packages/integrations/src/index.ts)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

05/06 for validated authoring; 02 test fixtures; 08 tool-like subworkflows; 10 approval for consequential tools; 12 cost controls.

Provider/privacy retention, prompt-injection handling, cost model, human confirmation and agent stop criteria; explicit configured access required.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Assistant application using normal authoring commands; versioned model integrations; worker budget/tool broker; web assistant/editor.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Suggested graph diff and explanation requiring user acceptance; model node input/output/schema settings, cost budget and approval affordances.

## Backend work

Catalog-constrained generation validated via normal graph admission, provider credential adapter, prompt/data policy and bounded model retries/cost. Tool invocation uses authorized pinned workflows, not arbitrary internal commands.

## Delivery slices

1. Start with explain/configure assistance and validated suggested draft edits, never auto-publish/run.
2. Add one structured-output model node with budget and clear nondeterminism.
3. Later tool use/agents/MCP require allowlists, iteration limits, approvals and evaluation datasets.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Malformed generated graph rejected, hallucinated node denied, prompt injection cannot gain tool rights, budget exhaustion, secret exclusion, output schema failures and approval race.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Autonomous production mutation, unbounded agents, hidden provider usage or sending real user payloads without policy.

## Rollout and rollback

Disable assistant/model admissions; ordinary manually authored workflows unaffected; in-flight tool effects keep their outcome records.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n's current documentation includes AI nodes/tools; this is an optional product direction, not a prerequisite for workflow parity. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md).

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

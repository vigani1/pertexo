# F09 — Workflow-authored failure paths and explicit recovery UX

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Existing recovery foundation + new graph behavior. Relative size: **XL**, not a calendar estimate.

## Outcome

Users can intentionally handle expected failures and understand safe recovery without repeating unknown side effects.

## Current implementation and evidence

Retries, cancellation, outcome_unknown, replay and external failure alerts exist. Replay starts a new run; it is not arbitrary continuation of a failed run. General error routes are not established.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/src/features/workflow-runs/workflow-runs.api.ts](../../apps/web/src/features/workflow-runs/workflow-runs.api.ts)
- [apps/web/src/features/workflow-settings/components/settings/failure-alerts-section.tsx](../../apps/web/src/features/workflow-settings/components/settings/failure-alerts-section.tsx)
- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; 02 for regression fixtures; 08 only if selecting reusable error workflows.

Handled error does not automatically mean business success. Define cancellation/timeouts/outcome_unknown eligibility; never auto-retry unsafe effects because a handler exists.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Model/engine failure semantics; database transition persistence; worker outcomes; contracts; web editor/run detail.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Per-node failure policy/error route, error schema mapping, clear handled-vs-failed outcomes and source-linked replay. Optional recovery console for operators only after contracts exist.

## Backend work

Versioned node/graph failure semantics in model/engine; sanitized error outputs, retry exhaustion before route selection, joins/loop propagation and run terminal rules. Preserve dispatch-aware retry restrictions.

## Delivery slices

1. Map existing retry/replay UI to contracts and close only real gaps.
2. ADR/select one initial failure-route model; implement isolated engine and persistence behavior.
3. Add authoring/run UI and tests; consider reusable error workflows separately after 08.
4. **Retry from the failed step**: a new run that reuses the recorded outputs of
   steps that already succeeded and executes from the failed step onward. It
   is offered only when the version is unchanged, the recorded outputs are
   still retained, and no earlier step ended `outcome_unknown`; otherwise the
   person gets a full replay with the reason. Lineage links the new run to the
   original. Needs its own ADR on reuse eligibility and retention.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Failure inside loop/join, error-handler failure, retries exhausted, unknown external effect, restart after route selection, no duplicate alert or side effect.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Arbitrary rewind or resuming the original run in place (retry from the failed step starts a new, linked run), retroactively editing immutable versions, guaranteeing exactly-once external effects.

## Rollout and rollback

Versioned readers remain; stop admitting new error-route versions while accepted runs settle.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n has error workflows and Make has incomplete execution recovery; our retry from the failed step is a new linked run with explicit reuse rules, not in-place continuation. Sources: [n8n error handling](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md); [Make incomplete execution management](https://help.make.com/manage-incomplete-executions).

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

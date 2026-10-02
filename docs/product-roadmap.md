# Pertexo product roadmap

Status: user-authorized sequential delivery; F00/F01 bounded local qualification
and release checks are complete through merged PR113/114. External qualification
remains open. F03 is delivered: every slice is merged, the local acceptance run is recorded
and the producer is on. Later feature plans retain their individual design/decision gates.
Created 2026-09-28 (Europe/Belgrade). User authorization is recorded separately
from this document; external provisioning, spending and production release
remain unapproved.

## Recommendation

**Finish the current structural cleanup, verify—not rebuild—the existing editor,
then implement the in-app notification inbox.** Follow with saved testing tools,
portable workflows/templates and reusable subworkflows. File inputs are useful
early, but only after a real consuming-node contract exists. Expand provider
integrations after the core workflow product is comfortable to use.

This roadmap contains **26 individually tracked plans: one release/evidence gate
and 25 feature or product-improvement plans**. It is not a promise to build every
optional feature, a fixed quota, or an exhaustive catalogue of everything any
competitor has ever offered. Later items are decision-gated options.

## Authority, snapshot and concurrent work

- Existing backend invariants remain governed by
  [backend plan](workflow-platform-backend-plan.md), accepted [ADRs](adr),
  current implementation and project instructions.
- Frontend ownership follows [web architecture](../apps/web/ARCHITECTURE.md) and
  [web instructions](../apps/web/AGENTS.md).
- This is a separate product roadmap, not a claim that original V1 deferred
  features are now approved or delivered. The old backend plan's historical
  backend-only repository description does not describe today's existing web app.
- Planning inventory began at e650ae31; the structural implementation chat
  concurrently advanced to 20778fea and later commits. Paths are evidence anchors,
  not a frozen future layout. Reconcile against the merged cleanup before coding.
- Structural cleanup lives in [backend structure audit](backend-structure-audit.md).
  This roadmap does not reopen that audit or add its work to feature plans.
- Cleanup is merged through PR99/100. F00/F01's historical starting source was
  `fcb0c44ca5d9f1a921165207fb33f2802d1688f7`. Their reviewed integration delivery
  and safe cleanup diagnostics are now merged through PR113/114 at
  `65a7c58bc02a47df660c49106bd4d9e0c5f69456`; natural main CI 36481275342 and
  CodeQL 36481275347 passed on that exact source. See F00/F01 for accepted local
  evidence and preserved external limitations. Do not repeat those journeys
  merely to update status or implement every roadmap row at once.
- Preserve existing dirty CONTEXT.md. The
  [notifications plan](workspace-notifications-plan.md) is the detailed F03
  plan under accepted [ADR055](adr/055-workspace-inbox-failure-threads.md).
  CONTEXT.md remains outside the scoped delivery changes.
- The initial roadmap planning inventory did not execute runtime qualification.
  Later feature-specific proofs are recorded in their plans. Current-code
  presence, historical verification and new acceptance requirements are distinct.
- Original intermittent account-link behavior remains an explicit qualification
  limitation, not “fixed” by a green run or by this roadmap.

## What already exists: do not build it twice

| Capability | Backend/current source | Frontend/current source | Roadmap treatment |
| --- | --- | --- | --- |
| Workspace identity, membership, invitations, connections | Existing modules/contracts | Existing management journeys | Keep; external auth/mail qualification separate |
| Draft editing, validation, immutable publish/version restore | Existing authoring and version contracts | Editor, version timeline/compare/restore | Verify gaps, not rebuild |
| Manual/webhook/schedule trigger | Existing acceptance/materialization | Trigger settings/delivery/occurrence views | Keep; polling is later |
| Set/Validate/Condition/Switch/Wait/For Each/Parallel/Merge/Terminate | Registered core nodes and engine | Catalog-backed editor | F01 completeness matrix |
| Nested For Each and scoped input | Existing bounded runtime | graph-scopes, body commands/layout and For Each tests exist | Existing; verify live and edge UX |
| JSONata and structured input mappings | Existing restricted evaluator and graph contract | Editable controls exist in mapping-source-editor | Existing; assistance/testing increment only |
| Run steps, status, input/output, events, cancel/replay | Existing run reads, SSE and commands | Run history/detail/thread/data UI | Keep; new error routing is F09 |
| Artifact bytes/upload/finalize/download | Existing storage/HTTP contracts; HTTP action emits artifacts | Metadata/download only in inspected artifact adapter | F04: usable consuming input + upload |
| External failure notifications | Existing policy/intent/delivery | Destinations and workflow alert settings | Keep separate from F03 personal inbox |
| Bounded workspace run statistics | ADR044 and scoped projection | Overview | Not full usage/billing; F12 |
| Undo, nested node duplication and graph identity handling | Draft persistence | Existing editor models/tests | Not workflow import/export; F05 |

Concrete anchors are in each plan. In particular, older M1 documentation saying
JSONata/structured mapping and nested authoring are deferred is behind current
source. F01 reconciles this with current evidence; no duplicate implementation.

### Gap classes

1. **Expose/qualify existing capability:** editor control coverage and real journeys.
2. **Complete a partially supported path:** files, richer testing, usage reads.
3. **New cross-stack product:** inbox, portability, subworkflows, approval/forms.
4. **Later optional platform expansion:** environments, governance, multiplayer,
   sandboxed code, customer tables, AI and commercial billing.

A frontend feature is not done because a control exists; a backend feature is not
user-delivered because a table or executor exists.

## Competitor comparison: capability benchmarks, not a scorecard

Official documentation was checked on 2026-09-28, and for the F26–F30 rows on
2026-09-29. “Not assessed” is not “absent”.
No prices, connector counts, blanket parity percentages or unsupported
performance/reliability rankings are asserted. Editions differ.

| User outcome | Verified competitor reference | Pertexo position / plan |
| --- | --- | --- |
| Reuse a callable workflow | [Zapier Sub-Zaps](https://help.zapier.com/hc/en-us/articles/8496308527629-Create-reusable-Zap-steps-with-the-Sub-Zap-app), [n8n subworkflows](https://docs.n8n.io/build/flow-logic/break-workflows-into-smaller-parts), [Make subscenarios](https://help.make.com/subscenarios) describe reusable calls | Missing reusable-call product; F08, distinct from loops |
| Edit safely while published workflow remains live | [Zapier drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions) documents drafts/version history | Already exists; qualify controls, don't rebuild |
| Test without repeated external effects | [n8n pinning and mocking](https://docs.n8n.io/build/work-with-data/pin-and-mock-data) distinguishes development pinning from production | Previews exist; durable fixtures/pins F02 |
| Share reusable workflow structure | [Make blueprints](https://help.make.com/blueprints) supports export/import with account reconnection | Safe portable format F05, curated onboarding F06 |
| Understand/recover failure | [n8n error handling](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md) and [Make incomplete execution management](https://help.make.com/manage-incomplete-executions) | Existing retry/replay; workflow-authored handling F09 is separate |
| Stop an automation that keeps failing | [Zapier turns off Zaps that keep erroring](https://help.zapier.com/hc/en-us/articles/8496216132621-Zap-is-not-running); [Make errors before deactivation](https://help.make.com/scenario-settings) | Missing; F26 pauses triggers and announces it in the inbox |
| Choose how failures reach each person | [Zapier error notification frequency](https://help.zapier.com/hc/en-us/articles/8496289225229-Manage-notifications-when-errors-occur-in-Zap-workflows) | F03 inbox plus per-workflow alerts exist; per-person preferences and email digest F27 |
| Keep a workflow from overlapping itself | [Make process data in order](https://help.make.com/scenario-settings) | Workspace limits only; per-workflow limit F29 |
| Sign in through the company directory | [Zapier SAML](https://help.zapier.com/hc/en-us/articles/8496279747085-Set-up-single-sign-on-with-SAML) and [SCIM](https://help.zapier.com/hc/en-us/articles/8496291497741-Provision-user-accounts-with-SCIM); [n8n SSO](https://docs.n8n.io/hosting/securing/set-up-sso/) | Password/social sign-in exists; organization SSO and provisioning F28 |
| Know a connection broke before runs fail | [Zapier app connections](https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections) marks expired connections for reconnection | Test-only health today; F30 |
| Human intervention before continuation | [Zapier Human in the Loop](https://help.zapier.com/hc/en-us/sections/38731226552845-Human-in-the-Loop) | New durable decision product F10 |
| Forms start workflows | [n8n Form Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.formtrigger) | New product F11 |
| File data in workflows | [n8n file and binary data](https://docs.n8n.io/build/work-with-data/handle-special-data-types/work-with-files-and-images) | Storage/output exists; complete input/consumer F04 |
| Reusable configuration and records | [n8n custom variables](https://docs.n8n.io/build/code-in-n8n/define-custom-variables), [n8n data tables](https://docs.n8n.io/build/work-with-data/data-tables) | Optional F13/F14 |
| Respond through a webhook | [n8n Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook) | Current 202 stays default; opt-in F15 |
| Promote between environments | [n8n source control and environments](https://docs.n8n.io/administer/use-source-control-and-environments) | Versioning exists, environment product F17 does not follow automatically |
| Organize workflows | [Make scenario capabilities](https://help.make.com/scenarios) documents folders/labels | Existing search; proposed metadata F07 |
| User code as a workflow step | [n8n Code node](https://docs.n8n.io/build/code-in-n8n/using-the-code-node) supports JavaScript/Python | Explicitly deferred; security-heavy F20 |
| Transform, review and AI breadth | [n8n current documentation index](https://docs.n8n.io/sitemap.md) lists transform nodes, reviews and AI features | Demand-driven F24, F18 and F22; not early parity blockers |

The priority ordering below is a Pertexo product recommendation inferred from
our existing investment, user preference and dependencies—not a claim from the
competitor sources. Our goal is coherent useful workflows, not matching every
competitor screen.

## Planning order versus implementation order

Plan all feature families now at the level in these files. Before coding a
selected feature, resolve its decisions, exact contracts and migrations against
the then-current code. Do not spend weeks finalizing far-future schemas.

### Plan first

1. **F00/F01/F03:** agree the starting evidence and first usable inbox slice.
2. **F26/F12/F29/F30:** settle pause, limits, concurrency and connection-health
   semantics together; they share admission and failure signals.
3. **F02/F04/F05:** design preview isolation, file consumer and portable format;
   they constrain later reuse without requiring immediate implementation.
4. **F08:** settle subworkflow pinning, input/output and parent/child durability
   early; do not code around those decisions with internal HTTP calls.
5. **F09/F10/F11:** settle handled-error and human-resume semantics together,
   keeping the domains distinct.
6. **F13/F16/F17/F28:** agree configuration and machine and organization
   identity before future environment and enterprise schema.
7. **F14/F18–F25:** refine only when a real user journey or commercial decision
   promotes the item. Their initial plans keep requirements from being forgotten.

### Recommended delivery sequence

| Wave | Order within wave | Why |
| --- | --- | --- |
| 0 — Close current work | F00/F01 (merged) → F03 inbox (delivered) | Trusted foundation and the first operational feedback loop |
| 1 — Run safely at scale | F26 auto-pause → F12 usage and limits → F29 per-workflow concurrency → F30 connection health | Before usage grows: stop runaway failures, measure and bound consumption, stop runs overlapping themselves, catch broken credentials early |
| 2 — Daily usability | F05 duplicate workflow (first slice) → F02 test cases → rest of F05 portability → F06 templates; F27 notification preferences; F07 organization | Safe iteration, reuse and a quieter, personal inbox |
| 3 — Reusable reliable automation | F08 subworkflows → F09 failure routes and retry from the failed step; F24 transforms; F21's generic OAuth2 connections for HTTP Request; F04 files once a file workflow is chosen | Expand what workflows can do while keeping behavior inspectable; OAuth2 widens API reach without bespoke connectors |
| 4 — Human workflows | F10 approvals → F11 forms/resume input; F13 configuration | Durable human actions and reusable configuration |
| 5 — Team and enterprise platform | F16 machine tokens → F17 environments; F18 governance; F28 single sign-on and provisioning; F19 comments/presence | Operational control for larger organizations; multiplayer remains its own later milestone |
| 6 — Optional power features | F14 data tables; F15 sync responses; F20 sandbox; F25 coordination | High cost/security/semantics; promote by demand, not to fill a checklist |
| 7 — Ecosystem expansion | F21 selected providers/polling (after its OAuth2 slice) → F22 AI, starting with a bounded model step before agents; F23 only after business approval | Breadth after the core product is complete, by product choice |

Waves express priority, not a requirement to finish every optional row before
moving on. The first complete core path is F00/F01 → F03 → F26/F12 → F02 →
F05/F06 → F08. Integrations stay late on purpose: the core product and its
safety controls come first, and providers are added on top of them.
File inputs can move ahead of templates if a validated file workflow is the
higher-value journey. A specific launch-critical provider may move earlier only
by explicit product choice, not automatically because polling was once named
a V1 follow-up.

### Hard dependency map

- F05 → F06; F05 + F13 + F16 → F17.
- F03 → F10 → resume-input part of F11; public start forms can be independent.
- F03 → F27 → notices from F26 (pauses), F12 (limits) and F30 (connection
  health); F26 can pause before F27 exists but announces pauses through F27's
  notice kinds.
- F12 → F29 queue visibility; F26 and F29 share run admission.
- F18 → F28 organization administration.
- F04 → file fields/parsers; not required for plain JSON subworkflows.
- F08 → reusable error workflows and AI tool workflows, not every error route.
- F12 → commercial F23; trustworthy measurement before pricing.
- F02 + an approved isolation design → F20; JSONata is not its sandbox.
- F19 multiplayer depends on its own protocol decision, not merely WebSockets.

## Feature register

Size is relative uncertainty/engineering breadth: M = bounded vertical slice,
L = several cross-stack slices, XL = consequential execution/security/state
contracts. These are not day estimates or commitments. Estimate a selected slice
only after its gate is resolved.

| ID / plan | Outcome | Work classification | Size | Status |
| --- | --- | --- | --- | --- |
| [F00](feature-plans/00-release-baseline.md) | Release baseline and existing-capability qualification | Existing implementation / evidence gate | M | PR verified/merged: bounded local gates closed; external qualification open |
| [F01](feature-plans/01-editor-capability-completion.md) | Complete and qualify the existing editor surface | Frontend-led parity, not a rebuild | M | PR verified/merged: bounded local gates closed; external qualification open |
| [F02](feature-plans/02-workflow-test-workspace.md) | Saved test cases, pinned samples and workflow regression runs | New product over existing previews | L | ADR061 first slice released with F05 through PR145 on natural main `c8a59b09`; natural CI36949789113 and CodeQL36949789141 pass; historical combined database evidence retained; pins/regression deferred |
| [F03](feature-plans/03-workspace-notifications.md) | Durable in-app notifications and live inbox | New frontend + backend product | L | Delivered: ADR055 database (PR118), worker (PR119), API (PR120) and web (PR123) slices merged; local acceptance recorded; producer on |
| [F04](feature-plans/04-artifact-inputs-and-files.md) | File inputs and artifact lifecycle | Backend foundation exists; consumer contract + frontend missing | L | Proposed |
| [F05](feature-plans/05-workflow-portability.md) | Workflow duplicate, safe import and export | New cross-stack authoring slice | M–L | Duplicate released through PR142 on natural main `5f78e155`; ADR062 import/export released with F02 through PR145 on natural main `c8a59b09`; natural CI36949789113 and CodeQL36949789141 pass; historical qualification/repair evidence retained; production activation unauthorized |
| [F06](feature-plans/06-curated-templates.md) | Curated workflow templates and guided setup | Frontend-led over portable authoring | M | Locally qualified and independently reviewed; primary final review/release open; production gates off |
| [F07](feature-plans/07-workflow-organization.md) | Folders, tags, favorites and workspace discovery | Metadata backend + frontend | M | Proposed |
| [F08](feature-plans/08-subworkflows.md) | Reusable subworkflows with durable parent/child runs | New execution capability across both stacks | XL | ADR065 accepted after primary/independent design review; qualified F07 base and migration0136 allocated; implementation starting; executable proof pending |
| [F09](feature-plans/09-failure-paths-and-recovery.md) | Workflow-authored failure paths and explicit recovery UX | Existing recovery foundation + new graph behavior | XL | Proposed |
| [F10](feature-plans/10-human-approvals.md) | Durable human approvals and resume decisions | New cross-stack durable interaction | XL | Proposed |
| [F11](feature-plans/11-forms-and-resume-input.md) | Hosted forms and structured human input | New trigger/frontend product | L–XL | Proposed |
| [F12](feature-plans/12-usage-and-insights.md) | Usage, limits and workflow insights without billing | Backend projection + frontend reporting | L | First capacity/activity slice locally verified; review/CI pending; warnings/trends deferred |
| [F13](feature-plans/13-configuration-and-variables.md) | Workspace variables and reusable non-secret configuration | New version-aware configuration | L | Proposed |
| [F14](feature-plans/14-data-tables.md) | Workflow-owned lookup tables and durable records | New optional storage product | XL | Proposed |
| [F15](feature-plans/15-synchronous-webhook-responses.md) | Bounded synchronous webhook responses | New opt-in trigger mode | XL | Proposed |
| [F16](feature-plans/16-automation-api-and-cli.md) | Scoped automation tokens, public API and CLI | Backend security product + developer UX | L–XL | Proposed |
| [F17](feature-plans/17-environments-and-promotion.md) | Development/production environments and safe promotion | New enterprise-oriented lifecycle | XL | Proposed |
| [F18](feature-plans/18-governance-and-audit.md) | Audit visibility, publishing approval and advanced access | Existing tenancy foundation + new governance UX | XL | Proposed |
| [F19](feature-plans/19-collaboration.md) | Comments and editing presence, then multiplayer | New frontend + coordination backend | XL | Proposed |
| [F20](feature-plans/20-sandboxed-code.md) | Sandboxed custom code nodes | New isolated execution platform | XL | Proposed |
| [F21](feature-plans/21-integrations-and-polling.md) | Provider expansion and durable polling/subscriptions | Later integration program | XL per provider family | Proposed |
| [F22](feature-plans/22-ai-assistance-and-ai-nodes.md) | AI authoring assistance, model nodes and controlled tools | Later optional capability | XL | Proposed |
| [F23](feature-plans/23-billing-and-commercialization.md) | Billing and commercial entitlements | Explicitly deferred optional business slice | XL | Proposed |
| [F24](feature-plans/24-data-transform-toolkit.md) | Discoverable data transforms and batch tools | New node UX over existing mapping/JSONata foundations | L | Proposed |
| [F25](feature-plans/25-event-coordination.md) | Business-event deduplication, debounce and throttling | Optional durable coordination beyond queue reliability | XL | Proposed |
| [F26](feature-plans/26-workflow-auto-pause.md) | Automatic pause of repeatedly failing workflows | New trigger control over existing run outcomes | L | Design accepted (ADR056); implementation next |
| [F27](feature-plans/27-notification-preferences-and-channels.md) | Notification preferences, email/digest delivery and more notice types | Extends the F03 inbox | L | Proposed |
| [F28](feature-plans/28-single-sign-on-and-provisioning.md) | Single sign-on (SAML/OIDC) and SCIM user provisioning | Extends the session authority for organizations | L–XL | Proposed |
| [F29](feature-plans/29-workflow-concurrency-controls.md) | Per-workflow concurrency limits with queue or skip | Extends run admission | M–L | Queue-only first slice qualified; skip overflow deferred |
| [F30](feature-plans/30-connection-health.md) | Connection health from real failures, used-by and reconnection | Extends existing connections | M–L | First Slack slice independently reviewed, merged through PR139/140 and qualified on natural main; production mode off |

## Shared implementation rules

Use the existing modular monorepo. The ownership map is authoritative in spirit,
while exact post-cleanup paths must be inspected before implementation.

| Owner | Owns | Must not own |
| --- | --- | --- |
| apps/web feature | User flow, presentation, feature HTTP adapter/Query, local form/editor state | SQL, worker imports, provider secrets, invented backend truth |
| apps/api feature | Transport/auth, use-case orchestration and public projection | Long node execution, duplicated durable policy or controller SQL |
| packages/contracts | Browser-safe HTTP/event schemas and generated contract output | Database row internals or runtime/provider clients |
| packages/workflow-model | Graph/value semantics and admission contracts | Framework transport or credential lifecycle |
| packages/node-sdk / node-catalog | Node interfaces, pinned registration and catalog composition | UI-specific state or durable run storage |
| packages/workflow-engine | Decisions from validated workflow/checkpoint/facts | Direct SQL, queue/network calls or live provider secrets |
| apps/worker | Leases, effectful adapters, outbox/queue consumption and durable orchestration | Independent graph truth or user permission bypass |
| packages/database | Transactions, tenant isolation, constraints, durable records/projections | JSX, provider HTTP or a second engine policy |
| packages/artifact-store | Byte storage and signed capability mechanics | Tenant authorization/accounting authority |
| packages/integrations | Versioned provider behavior and secure transport adapters | Generic one-size-fits-all retry policy |
| queue / rate-limit / observability | Their focused transport/atomic-limit/telemetry responsibilities | New feature business state |

- PostgreSQL remains durable authority; Redis/queues carry bounded work or
  wakeups. SSE delivers recoverable hints/snapshots; it is not a database.
- Use feature-first placement with deliberate public interfaces. No generic
  catch-all utils, speculative packages, empty scaffolding or parallel DTOs.
- Query owns remote data; Router owns navigation/filter state; the existing
  scoped editor owns unsaved graph. Preserve ETags and exact idempotency retries.
- New durable states define tenant/role checks, race winners, restart recovery,
  retention/deletion and outcome_unknown handling before UI states.
- Version executable semantics. Preserve old readers/executors and immutable
  pins; never rewrite historical workflows to simplify a new feature.
- Reuse tokens, existing UI primitives and error/pending/retry patterns.
  Every visible slice includes loading/empty/error/forbidden/conflict,
  keyboard/reduced-motion and mobile behavior.
- A required ADR precedes consequential implementation; no preassigned ADR
  numbers and no ADR for routine fixes. Existing backend checkpoints stay
  governed by their original plan until explicitly extended.
- Separate plan approval, code completion, local integrated verification,
  merged CI and production qualification. Never collapse these into “done”.
- **Put control in people's hands, with safe defaults.** Where workflows or
  people genuinely differ, make the behavior configurable. Each setting
  declares four things in its plan: a default that works untouched; a
  server-enforced range; its owner (workspace admins set workspace defaults,
  workflow editors override per workflow, each person sets their own
  notification preferences) and who may disable it, audited; and the
  consequence shown beside the control. Advanced settings sit behind
  progressive disclosure. Never configurable: tenant isolation, security and
  correctness guarantees (such as no automatic retry after `outcome_unknown`),
  legal holds, limits that protect other workspaces, and internal tuning such
  as batch sizes.

## Tracking and definition of done

Each feature file has a delivery tracker. Update the register and the
feature's evidence together. Allowed states: Proposed → Decision-ready → Approved
→ In progress → Locally verified → PR verified/merged → Production-qualified
(or Blocked with the exact missing decision/access). No feature is Approved by
the existence of this roadmap.

For each selected slice record:

1. Exact user journey and non-goals, current-source reconciliation and accepted
   decisions.
2. Changed modules/contracts/migrations, dependency ordering and privacy model.
3. Focused regression evidence; real database/race/restart checks where relevant.
4. Real browser + backend behavior for visible features; mocked evidence separate.
5. Additive rollout, rollback, retained-reader compatibility and operational
   metrics with bounded labels.
6. Independent review, exact source SHA/PR and relevant CI. After merge inspect
   the natural run once; failures get exact artifacts and causal follow-up, not
   blind reruns until green.
7. Remaining external gates: provider/OIDC/mail/object-store access, production
   load/recovery and security qualification where applicable.

Do not update original implementation-progress phase status just for these
proposals. Update it only if an approved implementation changes its claims.

## First selected planning session

F03 inbox was the first selected feature after the accepted F00/F01 local and
release gates; it is delivered, and wave 1 starts with F26 auto-pause. [ADR055](adr/055-workspace-inbox-failure-threads.md) replaced
[ADR054](adr/054-durable-workspace-inbox.md)'s per-recipient delivery, whose
increments merged inactive, with per-workflow threads computed on read. The
database, worker, API and frontend slices merged in that order, and the local
acceptance run is recorded with the producer on. Separately make
the F04 consumer decision and F08 input/output/pinning design; those are planning
tasks, not permission to start three large implementations at once.

No roadmap commits or pushes had occurred at the 2026-09-29 foundation
verification checkpoint. Keep these planning documents
out of the concurrent structural cleanup commits unless separately approved.

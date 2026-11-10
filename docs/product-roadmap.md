# Pertexo product status and roadmap

Status reconciled against main on 2026-11-10. “Delivered” means implemented on
main, not a claim of production, external-provider or smallest-host
qualification. Plans preserve detailed evidence and remaining limits. Pertexo is
both a personal engineering project and a product; outside adoption is not yet
established. Single-server self-hosting is the only supported deployment. A
later per-customer hosted version is unimplemented; AWS/ECS hosting proposals
are unsupported.

## Next, in order

1. Qualify single-server reliability: deployment/backup recovery, internal
   storage transport, compatibility preflight and measured host budgets. Close
   confirmed failures before expanding capability.
2. Extend useful integrations after the delivered generic OAuth2 and SMTP:
   choose connectors and polling from concrete workflows under F21's scoped
   plan.
3. Add a guided first run and improve first-use/accessibility friction. Current
   templates and the written guide do not constitute an in-product tutorial.
4. Consider the bounded AI slices in F22 after reliability and integrations.

SAML, SCIM, identity organizations and promotion remain supported capabilities.
License changes await legal review. Billing and optional later work below are
not promises or authorization to implement them. The completed architecture
reset is history, not this backlog.

## Feature register

F00–F49 are stable IDs. F00/F01 are qualification gates, not unbuilt features.
OAuth2 and SMTP are progress within F21; Python is F39, not an unfinished F20.
Use [feature plans](feature-plans/README.md) for scope and delivery evidence.

| ID                                                               | Capability                                                                                      | Current status                                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| F00                                                              | Release baseline and existing-capability qualification                                          | Implemented; bounded local/release checks complete; external qualification open                                    |
| F01                                                              | Complete and qualify the existing editor surface                                                | Implemented; bounded local/release checks complete; external qualification open                                    |
| [F02](feature-plans/02-workflow-test-workspace.md)               | Saved test cases, pinned samples and workflow regression runs                                   | Delivered; see plan for scope and qualification evidence                                                           |
| [F03](feature-plans/03-workspace-notifications.md)               | Durable in-app notifications and live inbox                                                     | Delivered; see plan for scope and qualification evidence                                                           |
| [F04](feature-plans/04-artifact-inputs-and-files.md)             | File inputs, parsing and artifact lifecycle                                                     | Delivered; see plan for scope and qualification evidence                                                           |
| F05                                                              | Workflow duplicate, safe import and export                                                      | Delivered; see plan for scope and qualification evidence                                                           |
| F06                                                              | Curated workflow templates and guided setup                                                     | Delivered: curated example selection/import; guided first-run tutorial remains open                                |
| F07                                                              | Folders, tags, favorites and workspace discovery                                                | Delivered; see plan for scope and qualification evidence                                                           |
| [F08](feature-plans/08-subworkflows.md)                          | Reusable subworkflows with durable parent/child runs                                            | Delivered; see plan for scope and qualification evidence                                                           |
| [F09](feature-plans/09-failure-paths-and-recovery.md)            | Workflow-authored failure paths and explicit recovery UX                                        | Delivered: recovery, supported failure routes and error workflows; broader loop/join/Call/artifact routes deferred |
| [F10](feature-plans/10-human-approvals.md)                       | Durable human approvals and resume decisions                                                    | Delivered; see plan for scope and qualification evidence                                                           |
| [F11](feature-plans/11-forms-and-resume-input.md)                | Hosted forms and structured human input                                                         | Delivered; see plan for scope and qualification evidence                                                           |
| [F12](feature-plans/12-usage-and-insights.md)                    | Usage, limits and workflow insights without billing                                             | Delivered; see plan for scope and qualification evidence                                                           |
| [F13](feature-plans/13-configuration-and-variables.md)           | Workspace variables and reusable non-secret configuration                                       | Delivered; see plan for scope and qualification evidence                                                           |
| [F14](feature-plans/14-data-tables.md)                           | Workspace data tables                                                                           | Delivered: bounded typed rows, CSV and workflow operations                                                         |
| [F15](feature-plans/15-synchronous-webhook-responses.md)         | Bounded synchronous webhook responses                                                           | Delivered; see plan for scope and qualification evidence                                                           |
| [F16](feature-plans/16-automation-api-and-cli.md)                | Scoped automation tokens, public API and CLI                                                    | Delivered; see plan for scope and qualification evidence                                                           |
| [F17](feature-plans/17-environments-and-promotion.md)            | Development/production environments and safe promotion                                          | Delivered; see plan for scope and qualification evidence                                                           |
| [F18](feature-plans/18-governance-and-audit.md)                  | Audit log and publishing approval                                                               | Delivered; see plan for scope and qualification evidence                                                           |
| [F19](feature-plans/19-collaboration.md)                         | Comments and editing presence, then multiplayer                                                 | Delivered: comments, mentions and advisory presence; multiplayer deferred                                          |
| [F20](feature-plans/20-sandboxed-code.md)                        | JavaScript Code step in an isolated runner                                                      | Delivered: isolated JavaScript Code; Python tracked as F39                                                         |
| [F21](feature-plans/21-integrations-and-polling.md)              | Provider expansion and durable polling/subscriptions                                            | Partially delivered: generic OAuth2 and SMTP; broader connectors and polling proposed                              |
| [F22](feature-plans/22-ai-assistance-and-ai-nodes.md)            | AI authoring assistance, model nodes and controlled tools                                       | Proposed; not implemented                                                                                          |
| [F23](feature-plans/23-billing-and-commercialization.md)         | Billing and commercial entitlements                                                             | Proposed; not implemented                                                                                          |
| [F24](feature-plans/24-data-transform-toolkit.md)                | Discoverable data transforms and batch tools                                                    | Delivered; see plan for scope and qualification evidence                                                           |
| [F25](feature-plans/25-event-coordination.md)                    | Business-event deduplication, debounce and throttling                                           | Delivered; see plan for scope and qualification evidence                                                           |
| F26                                                              | Automatic pause of repeatedly failing workflows                                                 | Delivered; see plan for scope and qualification evidence                                                           |
| [F27](feature-plans/27-notification-preferences-and-channels.md) | Notification preferences, email/digest delivery and more notice types                           | Delivered; see plan for scope and qualification evidence                                                           |
| [F28](feature-plans/28-single-sign-on-and-provisioning.md)       | Single sign-on (SAML/OIDC) and SCIM user provisioning                                           | Delivered; see plan for scope and qualification evidence                                                           |
| [F29](feature-plans/29-workflow-concurrency-controls.md)         | Per-workflow concurrency limits with queue or skip                                              | Delivered; see plan for scope and qualification evidence                                                           |
| [F30](feature-plans/30-connection-health.md)                     | Connection health from real failures, used-by and reconnection                                  | Delivered: Slack health from real outcomes, used-by and reconnection; broader providers remain open                |
| [F31](feature-plans/31-two-factor-sign-in.md)                    | Two-factor sign-in: authenticator app and recovery codes for password accounts; passkeys later  | Delivered; see plan for scope and qualification evidence                                                           |
| [F32](feature-plans/32-http-pagination.md)                       | HTTP Request pagination: follow next-page links or page counters, within bounds                 | Delivered; see plan for scope and qualification evidence                                                           |
| [F33](feature-plans/33-step-retry-settings.md)                   | Retry settings per step: how many tries and the wait between them                               | Delivered; see plan for scope and qualification evidence                                                           |
| [F34](feature-plans/34-create-file.md)                           | Create a file: CSV, JSON or text from step data, kept as a run file                             | Delivered; see plan for scope and qualification evidence                                                           |
| [F35](feature-plans/35-webhook-test-events.md)                   | Webhook test events: listen in the editor and keep a real request as sample data                | Delivered; see plan for scope and qualification evidence                                                           |
| [F36](feature-plans/36-light-theme.md)                           | Light theme alongside the dark one                                                              | Delivered; see plan for scope and qualification evidence                                                           |
| [F37](feature-plans/37-canvas-notes.md)                          | Notes on the workflow canvas                                                                    | Delivered; see plan for scope and qualification evidence                                                           |
| [F38](feature-plans/38-utility-steps.md)                         | Utility steps: XML/HTML parsing, hashes, signatures and IDs, text and number formatting         | Delivered; see plan for scope and qualification evidence                                                           |
| F39                                                              | Python in the Code step                                                                         | Delivered; see plan for scope and qualification evidence                                                           |
| F40                                                              | Community-built steps through a public step SDK                                                 | Proposed; not implemented                                                                                          |
| F41                                                              | External secret stores for connection credentials                                               | Proposed; not implemented                                                                                          |
| F42                                                              | Log streaming to external monitoring                                                            | Proposed; not implemented                                                                                          |
| F43                                                              | Interface languages                                                                             | Proposed; not implemented                                                                                          |
| F44                                                              | Mobile apps                                                                                     | Proposed; not implemented                                                                                          |
| [F45](feature-plans/45-bigger-files-and-paged-data.md)           | Bigger files and step data beyond 1 MiB, by streaming or paging                                 | Delivered; see plan for scope and qualification evidence                                                           |
| F46                                                              | Resume a waiting run when another system calls a per-run URL                                    | Delivered; see plan for scope and qualification evidence                                                           |
| [F47](feature-plans/47-run-values.md)                            | Save a few business values on a run and find runs by them                                       | Delivered; see plan for scope and qualification evidence                                                           |
| [F48](feature-plans/48-finer-sharing.md)                         | Finer sharing: access to chosen folders or workflows, and connections shared with chosen people | Delivered; see plan for scope and qualification evidence                                                           |
| F49                                                              | Git sync for workflows                                                                          | Proposed; not implemented                                                                                          |

## Shared implementation rules

Use the existing modular monorepo. The ownership map is authoritative in spirit,
while exact post-cleanup paths must be inspected before implementation.

| Owner                              | Owns                                                                           | Must not own                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| apps/web feature                   | User flow, presentation, feature HTTP adapter/Query, local form/editor state   | SQL, worker imports, provider secrets, invented backend truth    |
| apps/api feature                   | Transport/auth, request validation and public projection                       | Long node execution, duplicated durable policy or controller SQL |
| packages/contracts                 | Browser-safe HTTP/event schemas and generated contract output                  | Database row internals or runtime/provider clients               |
| packages/workflow-model            | Graph/value semantics and admission contracts                                  | Framework transport or credential lifecycle                      |
| packages/node-sdk / node-catalog   | Node interfaces, pinned registration and catalog composition                   | UI-specific state or durable run storage                         |
| packages/workflow-engine           | Decisions from validated workflow/checkpoint/facts                             | Direct SQL, queue/network calls or live provider secrets         |
| apps/worker                        | Leases, effectful adapters, outbox/queue consumption and durable orchestration | Independent graph truth or user permission bypass                |
| packages/core                      | Product flows, queries, authorization and durable decisions                    | SQL outside its repositories or HTTP transport                   |
| packages/database                  | Transactions, tenant isolation, constraints, durable records/projections       | JSX, provider HTTP or a second engine policy                     |
| packages/artifact-store            | Byte storage and signed capability mechanics                                   | Tenant authorization/accounting authority                        |
| packages/integrations              | Versioned provider behavior and secure transport adapters                      | Generic one-size-fits-all retry policy                           |
| queue / rate-limit / observability | Their focused transport/atomic-limit/telemetry responsibilities                | New feature business state                                       |

- PostgreSQL remains durable authority; Redis/queues carry bounded work or
  wakeups. SSE delivers recoverable hints/snapshots; it is not a database.
- Use feature-first placement with deliberate public interfaces. No generic
  catch-all utils, speculative packages, empty scaffolding or parallel DTOs.
- Query owns remote data; Router owns navigation/filter state; the existing
  scoped editor owns unsaved graph. Preserve ETags and exact idempotency
  retries.
- New durable states define tenant/role checks, race winners, restart recovery,
  retention/deletion and outcome_unknown handling before UI states.
- Version executable semantics. Preserve old readers/executors and immutable
  pins; never rewrite historical workflows to simplify a new feature.
- Reuse tokens, existing UI primitives and error/pending/retry patterns. Every
  visible slice includes loading/empty/error/forbidden/conflict,
  keyboard/reduced-motion and mobile behavior.
- A required ADR precedes consequential implementation; no preassigned ADR
  numbers and no ADR for routine fixes. Existing backend checkpoints stay
  governed by their original plan until explicitly extended.
- Separate plan approval, code completion, local integrated verification, merged
  CI and production qualification. Never collapse these into “done”.
- **Put control in people's hands, with safe defaults.** Where workflows or
  people genuinely differ, make the behavior configurable. Each setting declares
  four things in its plan: a default that works untouched; a server-enforced
  range; its owner (workspace admins set workspace defaults, workflow editors
  override per workflow, each person sets their own notification preferences)
  and who may disable it, audited; and the consequence shown beside the control.
  Advanced settings sit behind progressive disclosure. Never configurable:
  tenant isolation, security and correctness guarantees (such as no automatic
  retry after `outcome_unknown`), legal holds, limits that protect other
  workspaces, and internal tuning such as batch sizes.

## Tracking and definition of done

Each feature file has a delivery tracker. Update the register and the feature's
evidence together. Allowed states: Proposed → Decision-ready → Approved → In
progress → Locally verified → PR verified/merged → Production-qualified (or
Blocked with the exact missing decision/access). No feature is Approved by the
existence of this roadmap.

For each selected slice record:

1. Exact user journey and non-goals, current-source reconciliation and accepted
   decisions.
2. Changed modules/contracts/migrations, dependency ordering and privacy model.
3. Focused regression evidence; real database/race/restart checks where
   relevant.
4. Real browser + backend behavior for visible features; mocked evidence
   separate.
5. Forward fixes and rollback preserve accepted durable facts; one current
   format follows ADR 069 until launch. Operational metrics have bounded labels.
6. Independent review, exact source SHA/PR and relevant CI. After merge inspect
   the natural run once; failures get exact artifacts and causal follow-up, not
   blind reruns until green.
7. Remaining external gates: provider/OIDC/mail/object-store access, production
   load/recovery and security qualification where applicable.

Use the feature plans to record delivery status. The completed architecture
reset plan is historical evidence, not an active tracker.

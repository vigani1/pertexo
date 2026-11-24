# Feature plans

[Product roadmap](../product-roadmap.md) gives the current priorities. This
index links to scope and delivery evidence. Historical plans record what was
agreed and verified at the time.

## Open programs

- [F21 — Provider expansion and durable polling](21-integrations-and-polling.md).
  Generic OAuth2, SMTP, PostgreSQL actions, and HTTP and PostgreSQL polling
  have shipped. Broader connectors and subscriptions remain open.
- [F23 — Billing and commercial entitlements](23-billing-and-commercialization.md)
  is a proposal.
- F40–F44 cover deferred work on a general-purpose step SDK, external connection
  secret stores, log streaming as a product feature, localization, and native
  mobile apps. The declarative community package format ships in F64.

F00 and F01 are baseline and editor qualification gates. The repository has
passed bounded checks. External qualification is tracked with the relevant
feature and the [deployment runbook](../operations/single-server.md).

## Delivered feature scope and evidence

- [F22 — AI and MCP program](22-ai-assistance-and-ai-nodes.md) links to its
  delivered slices.
- [F21 slice 0 — Generic OAuth2](21a-oauth2-connections.md) and
  [F21b — Integration sequence](21b-next-integrations.md) record the delivery
  scope and remaining provider work.

### Core workflows and workspaces

- [F02 — Run-input cases and pinned samples](02-workflow-test-workspace.md)
- [F03 — Durable in-app notifications and live inbox](03-workspace-notifications.md)
- [F04 — File inputs and artifact lifecycle](04-artifact-inputs-and-files.md)
- F05 — Duplicate workflows and safely import or export them.
- [F06 — Templates and guided first run](../guides/getting-started.md)
- F07 — Folders, tags, favorites and workspace discovery.
- [F08 — Reusable subworkflows after the architecture reset](08-subworkflows.md)
- [F09 — Failure paths, recovery and error workflows](09-failure-paths-and-recovery.md)
- [F10 — Durable human approvals](10-human-approvals.md)
- [F11 — Forms and requested member input](11-forms-and-resume-input.md)
- [F12 — Capacity warnings and run trends](12-usage-and-insights.md)
- [F13 — Workspace variables](13-configuration-and-variables.md)
- [F14 — Workspace data tables](14-data-tables.md)
- [F15 — Respond to webhook](15-synchronous-webhook-responses.md)
- [F16 — Scoped automation tokens, public API and CLI](16-automation-api-and-cli.md)
- [F17 — Environments and promotion](17-environments-and-promotion.md)
- [F18 — Audit log and publishing approval](18-governance-and-audit.md)
- [F19 — Comments and editing presence](19-collaboration.md)
- [F20 — Code step](20-sandboxed-code.md)

### Workflow capabilities

- [F24 — Discoverable bounded data transforms](24-data-transform-toolkit.md)
- [F25 — Trigger event coordination](25-event-coordination.md)
- [F26 — Automatic pause after repeated failures](bounded-auto-pause-evidence.md)
- [F27 — Personal notifications and system mail](27-notification-preferences-and-channels.md)
- [F28 — Single sign-on and provisioning](28-single-sign-on-and-provisioning.md)
- [F29 — Workflow concurrency](29-workflow-concurrency-controls.md)
- [F30 — Connection health and reconnection](30-connection-health.md)
- [F31 — Two-factor sign-in](31-two-factor-sign-in.md)
- [F32 — HTTP Request pagination](32-http-pagination.md)
- [F33 — Step retry settings](33-step-retry-settings.md)
- [F34 — Create file](34-create-file.md)
- [F35 — Webhook test events](35-webhook-test-events.md)
- [F36 — Light and dark appearance](36-light-theme.md)
- [F37 — Notes on the workflow canvas](37-canvas-notes.md)
- [F38 — Utility steps](38-utility-steps.md)
- [F39 — Python in the Code step](39-python-code.md)
- [F45 — Bigger files and paged step data](45-bigger-files-and-paged-data.md)
- [F46 — Resume a Wait through a callback](46-callback-resume.md)
- [F47 — Run values](47-run-values.md)
- [F48 — Finer sharing](48-finer-sharing.md)

### Files, integrations and AI

- [F49 — Email attachments](49-email-attachments.md)
- [F50 — Timeout paths for approvals and input requests](50-task-timeout-paths.md)
- [F51 — Spreadsheet files (Excel)](51-spreadsheet-files.md)
- [F52 — File uploads in forms and input requests](52-form-file-uploads.md)
- [F53 — Database step (PostgreSQL)](53-database-step.md)
- [F54 — HTTP polling trigger](54-polling-triggers.md)
- [F55 — Database row trigger (PostgreSQL)](55-database-row-trigger.md)
- [F56 — AI Model step](56-ai-model-step.md)
- [F57 — Integration modules](57-integration-modules.md)
- [F58 — Inline pure steps](58-inline-pure-steps.md)
- [F59 — AI Classify step](59-ai-classify-step.md)
- [F60 — MCP server and client step](60-mcp.md)
- [F61 — AI Agent step](61-ai-agent-step.md)
- [F62 — AI authoring assistant](62-ai-authoring-assistant.md)
- [F63 — AI Guardrails and evaluations](63-ai-guardrails-and-evaluations.md)
- [F64 — Community integrations](64-community-integrations.md)

## Supporting plans and historical checkpoints

- [Single-server beta deployment](single-server-beta.md). For current commands, use the [operator runbook](../operations/single-server.md).
- [Operator reliability and host sizing](operator-reliability.md)
- [CI browser reach](browser-ci-reach.md)
- [API refactor batch J4](batch-j4-api.md)
- [Cost of pure steps](step-transaction-cost.md)
- [Run admission under a backlog](run-admission-under-backlog.md)
- [Step setup from the catalog schema](step-setup-from-schema.md)
- [Lazy chunk recovery after a deployment](lazy-chunk-recovery.md)
- [Local connections and Weft page follow-up](local-connections-and-weft.md)
- [Weft phone editor header](phone-editor-header.md)
- [Show public form links again](public-form-link.md)
- [Row security rewrite](row-security-rewrite.md)
- [Run actions and feedback](run-action-feedback.md)
- [Self-managed encryption keys](self-managed-encryption.md)
- [SMTP system mail](smtp-delivery.md)
- [Step capability upgrades](step-capability-upgrades.md)
- [Web and API polish follow-ups](web-api-polish.md)
- [Lighter web first load](web-first-load.md)
- [Webhook authentication modes](webhook-authentication.md)
- [Weft design pass](weft-design-pass.md)
- [Weft second pass](weft-second-pass.md)

### Completed polish and layout work

- [Shared controls](https://github.com/vigani1/pertexo/commit/b895b6f71) for dialogs, file inputs and empty states, plus [responsive capacity cards](https://github.com/vigani1/pertexo/commit/6ca074749).
- [Editor polish](https://github.com/vigani1/pertexo/commit/47fd86762) for test output, presence and responsive panels.
- [Selection in the glyph column](https://github.com/vigani1/pertexo/commit/08f84365d) and [menus that fit the viewport](https://github.com/vigani1/pertexo/commit/dd13acb69) on the workflow list.
- The [move verification](https://github.com/vigani1/pertexo/commit/9c095bd25) records the completed node, run-model and persistence layout pass. The [architecture guide](../architecture.md) describes the current layout.

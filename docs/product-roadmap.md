# Pertexo product status and roadmap

Status as of 2026-11-24. Delivered means merged to `main`. Live-provider and
production qualification are recorded separately in the relevant plans.

## What ships

- The supported deployment runs Docker Compose on a Linux server. The
  [operator runbook](operations/single-server.md) covers installation, sizing,
  backups and monitoring. The same stack can be operated by you or a customer.
- A [guided first run](guides/getting-started.md), durable workflows, saved test
  cases, team collaboration, and workspace controls for access and publishing.
- HTTP and OAuth2, Slack, SMTP, and PostgreSQL steps, plus HTTP and PostgreSQL
  polling triggers. [Community packages](guides/community-integration-authoring.md)
  can add approved declarative HTTP actions.
- [AI and MCP](feature-plans/22-ai-assistance-and-ai-nodes.md) cover model calls,
  classification, agents, guardrails, evaluations, run explanations, and draft
  proposals. MCP exposes selected published workflows and calls external tools.

## Next, in order

1. Run a private beta on the supported single-server stack. Use real workflows
   to prioritize onboarding friction, provider compatibility and host sizing.
2. Choose the next native integrations from real workflow needs. The
   [integration plan](feature-plans/21-integrations-and-polling.md) records the
   starting points and remaining scope.

A managed per-customer service, billing, Git sync, native mobile apps and
localization remain future options. The earlier AWS/ECS proposals are
[historical](adr/071-single-server-beta.md).

## Feature register

The [feature plan index](feature-plans/README.md) records scope, status and
links to delivery evidence.

## Shared implementation rules

Follow the [repository instructions](../AGENTS.md),
[current architecture](architecture.md) and [active decisions](adr/README.md).
Record any external qualification still required in the relevant feature plan.
The [architecture reset plan](architecture-reset-plan.md) records the previous
migration.

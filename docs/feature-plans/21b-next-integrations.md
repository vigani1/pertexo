# F21b — Integration delivery sequence

Part of [F21](21-integrations-and-polling.md). Choose additional connectors from
real workflow needs after the private beta.

## Delivered foundations

- [Generic OAuth2](21a-oauth2-connections.md) for HTTP Request, and
  [SMTP](../guides/email.md) for Send email.
- [F53 — PostgreSQL actions](53-database-step.md) run parameterized queries and
  write rows through a workspace connection.
- [F54 — HTTP polling](54-polling-triggers.md) and
  [F55 — PostgreSQL row triggers](55-database-row-trigger.md) share the durable
  position and recovery rules in [ADR 093](../adr/093-polling-triggers.md).

## Provider candidates

- Read, append and update Google Sheets rows, and trigger on new rows.
- Send from Gmail and Microsoft 365 accounts and trigger on new mail.
- Add a Slack Events trigger alongside the existing Slack message action.
- MySQL, Notion, Airtable, Google Drive and Calendar, Telegram, Discord,
  HubSpot and Stripe remain candidates.

Reuse the [integration module](57-integration-modules.md) and the existing
polling or webhook flow where it fits. Verify the chosen provider's scopes,
quotas, credential lifecycle and trigger recovery in its sandbox before
claiming provider compatibility. [F21](21-integrations-and-polling.md) owns the
acceptance checklist.

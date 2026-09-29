# F27 — Notification preferences, channels and notice types

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-29. Parent: [product roadmap](../product-roadmap.md).
Scope: Extends the F03 inbox. Relative size: **L**, not a calendar estimate.

## Outcome

Each person decides which workspace notices reach them and how: in the app,
by email right away, or as a digest. Builders can follow the workflows they
work on, and the inbox covers more than failed runs: paused workflows,
connections that need attention and limits being reached.

## Current implementation and evidence

[F03](03-workspace-notifications.md) delivers one notice per failing workflow
to owners, admins and operators, with private read state and live updates
([ADR055](../adr/055-workspace-inbox-failure-threads.md)). ADR 022 sends
per-workflow external failure alerts to configured Slack or email
destinations; that stays a separate, workflow-level feature. There is no
per-person preference, email delivery of inbox notices, or notice kind other
than run failures.

Inspected anchors (paths may move):

- [docs/feature-plans/03-workspace-notifications.md](03-workspace-notifications.md)
- [docs/adr/022-run-failure-notification.md](../adr/022-run-failure-notification.md)
- [docs/adr/040-durable-authentication-mail-delivery.md](../adr/040-durable-authentication-mail-delivery.md)

## Dependencies and planning gate

F03 complete. F26 for pause notices; F12 for limit notices; authoritative
connection health transitions for connection notices (never inferred from one
failed request).

Resolve in an ADR before code:

- **Notice kinds** as more thread subjects on ADR055's model: one thread per
  subject (workflow, connection, limit), each with its own audience rule.
- **Muting**: a person hides one workflow's or connection's notices; muting is
  private and never affects others or external alerts.
- **Following**: builders and viewers can follow a workflow they may read runs
  of, joining its audience without gaining any other capability.
- **Email delivery**: per person, immediately or as an hourly or daily digest,
  with a workspace default. Email is sent per thread change, coalesced, never
  once per failure, through the existing durable mail delivery; it carries no
  run input, output or provider error text.
- **Preference storage** per person and workspace, removed with membership.

## User-configurable settings

Recommended values, confirmed in this feature's ADR. The server enforces every
range; the control states its consequence.

| Setting | Default | Range | Who changes it | Consequence shown |
| --- | --- | --- | --- | --- |
| Email | Off (in the app only) | Off, immediately, hourly digest, daily digest | Each person; workspace admins set the default | “You get one email per changed notice, or one digest” |
| Daily digest time | 09:00 in the person's time zone | Any hour | Each person | “Your digest arrives at this time” |
| Mute a workflow or connection | Not muted | Muted or not | Each person | “You stop seeing its notices; others still do” |
| Follow a workflow | Not followed | Followed or not | Each person who may read its runs | “You get its notices without any other access” |

## Ownership and structure

Database preference, follow and mute state plus notice kinds; worker digest and
email delivery; contracts; web notification settings and inbox filters.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).

## Frontend work

A notification settings page per workspace (channels, digest, workspace
default for admins); mute and follow actions on inbox threads and workflows;
inbox filters by notice kind; unsubscribe links from email.

## Backend work

Preference, mute and follow persistence with RLS; audience rules per notice
kind; producers for pause, connection-health and limit notices; a digest job
and immediate email path over the existing durable mail delivery, bounded and
deduplicated per thread change.

## Delivery slices

1. ADR for notice kinds, audience, mute/follow and email semantics.
2. Mute and follow with real-database eligibility tests and inbox UI.
3. Email delivery: immediate and digest, with preferences and unsubscribe.
4. New notice kinds as their producers become available (F26, F12,
   connection health).

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Muting hides only that person's notices; following grants no other access;
losing membership removes preferences and stops email; a noisy workflow sends
one email per digest window, not per failure; unsubscribe works without
signing in only for that preference; email contains no sensitive run data.

## Non-goals

Mobile push, chat-app delivery of inbox notices (ADR 022 destinations remain
the way to post to Slack), notice acknowledgement or incident management.

## Rollout and rollback

Email starts off by default per workspace; turning it off stops sends without
losing preferences. New notice kinds ship behind their producer's flag.

No production rollout, paid provisioning or real external calls are authorized
by this plan.

## Competitor context

Zapier lets each person choose immediate, hourly-summary or no error emails,
with per-app frequencies and labels
([manage error notifications](https://help.zapier.com/hc/en-us/articles/8496289225229-Manage-notifications-when-errors-occur-in-Zap-workflows)).

Research checked 2026-09-29; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation.

## Delivery tracker

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and privacy/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: none for this new plan.

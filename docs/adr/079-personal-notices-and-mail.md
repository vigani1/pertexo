# ADR 079: Personal views of subject notices and durable system mail

- **Status:** accepted under the owner's autonomous feature instruction
- **Date:** 2026-10-15
- **Plan:** [F27](../feature-plans/27-notification-preferences-and-channels.md)
- **Amends:** ADR 055's workflow-only thread identity/audience and ADR 040's
  authentication-only use of the existing system mail queue

## Context

Per-person preferences must not multiply every failed run by every recipient or
create another inbox. Existing durable mail already owns encrypted content,
claims, retries and uncertain SMTP outcomes. Current pause, connection, capacity
and human-task facts already provide durable attention sources.

## Decision

Generalize the existing inbox thread/read identity to one UUID thread per
workspace, notice kind and UUID subject. Preserve F03 failure aggregation and
private reads. Keep its failure-event input; new operational notices are bounded
observations of current authoritative attention, including resolution. They are
not an exhaustive event history. Active slots being occupied is normal queueing;
queue and artifact byte/count saturation are capacity attention.

Compute each person's current view from membership, the notice's audience,
workflow follow and private mute. Following adds only that workflow's notices
through run-read access. Mutes never change another person's view, a human task or
shared ADR 022 alerts. Approval waiting uses the pending-task eligibility owner,
including the captured Approval starter choice (default excluded, explicit
per-step opt-in allowed under ADR 076). Resolved operational notices leave current attention;
failure threads retain F03's window. Inbox guards allow current workspace members,
with precise row eligibility and private read state under forced RLS.

Personal email inherits an Off workspace default unless overridden. Owners/admins
manage that default through an explicit capability. Modes are Off, immediate,
hourly or daily with IANA timezone/hour. Immediate is bounded to one batch per
person/workspace/minute; digests coalesce current unseen thread changes. Gaps use
the first valid later local time; repeated hours send once; downtime causes one
catch-up, not one email per missed window. Enabling/changing a subscription does
not email old history. All loops, scans, recipients and mail bodies are bounded.

Reuse one system mail queue, lease/settlement protocol and worker delivery owner
for authentication and workspace notices. Preserve existing physical queue/AAD
identities and pending ciphertexts; give security mail priority. One pending batch
and a window reservation prevent duplicate preparation. Witness revisions per
thread instead of relying on a global sequence's commit order. Only a definitive
pre-dispatch supersession releases a reservation. SMTP possible-delivery outcomes
stay in reconciliation and are never automatically repeated.

Notice mail contains bounded safe summaries and own-origin links only. Recheck
current workspace/user/membership incarnation, verified email, preferences/default
and every included subject immediately before dispatch. Refuse obsolete content
before the transport sends it and rebuild eligible content later. No run data,
variable values, provider errors or task instructions/comments enter notice mail.

Unsubscribe uses the existing versioned application envelope/key ring, scoped to
one person/workspace/preference revision/membership incarnation and expiry. The
capability is carried in a fragment and redacted header. GET confirms, POST turns
only personal email Off. Old links cannot undo a later opt-in or rejoined
membership. Approval actions remain authenticated. Removal/departure clears
private state; workspace purge also removes linked pending mail.

### Amendment: one TypeScript audience owner (2026-10-15)

`database/src/inbox/eligibility.ts` owns the complete notice audience predicate.
Inbox reads/counts/revisions/read commands and mail preparation/authorization use
it before pagination. It derives capability audiences from the existing role
policy and reuses `runs/pending-tasks/eligibility.ts` for approvals. Follow and
mute are notice choices; a mute never hides or resolves a task.

Remove the persistent SQL `workspace_notice_visible` business rule. SQL thread
security keeps the workspace and active workspace/user/member fence, with the
existing trusted worker scope and private read/preference policies. This amends
ADR 055's claim that SQL enforces the entire business audience. The application
must always apply its shared predicate; SQL is the isolation fence.

Stop older API/worker readers before this migration and restart matching binaries.
Old readers that relied solely on the SQL policy must not run after it is removed.
This uses the existing coordinated deployment, without a new service or role.

## Consequences

### Amendment: authenticated task context (2026-10-15)

An eligible Approval Inbox notice may display ADR 076's captured bounded detail
fields. Requested-input rows use the same task projection. This is an explicit
authenticated read of retained task data, never part of the notice email, stream
hint, audit or error-workflow summary. Current task eligibility still gates the
approval notice and its context together.

One inbox, one mail delivery algorithm and the existing worker/transport serve
these behaviors. No new service, account, role, package or CI job. The additive
migration preserves populated private reads and matching readers precede writers.
Email starts Off and remains best effort; Inbox/task facts are authoritative.
Current-attention polling may coalesce brief transitions. Shared alerts remain
independent. Push, chat channels, public decisions and incident management remain
later work, without placeholder subsystems.

### Amendment: named system mail and one-click opt-out (2026-10-16)

Notice subjects include the workflow/connection and workspace names; digests name
one subject and the total count. Existing safe projections, Unicode bounds and
the 12 KiB envelope remain. The shared delivery table becomes
`system_mail_deliveries`, retaining rows, grants, references, encrypted content and
claim state. Existing cryptographic AAD and provider identities retain their old
strings so queued messages remain readable and retry the identical command.

Reuse the existing revision-bound capability for RFC 8058 one-click POST, accepting
`application/x-www-form-urlencoded` or `multipart/form-data` within 8 KiB. The
URL token authorizes the command; ignore the body without parsing it. No new
parser dependency or custom multipart decoder. No cookie,
session, CSRF secret or redirect is required for POST. A manual GET only redirects
to the existing same-origin fragment confirmation page; it never opts out. Keep
that human confirmation and its header-authorized command. The body ceiling and MIME restriction
apply to the new endpoint; authentication still forwards form bytes to Better Auth. Both transports add the two fixed headers only
when the sealed payload contains its optional unsubscribe URL; legacy payloads
and security mail keep their behavior.

The beta edge routes the capability endpoint directly to the existing API,
bypassing nginx request/error logs. Caddy filters query tokens, request headers
and redirect Location from its runtime logs, including upstream failures. No new
service, key, role or CI job. Stop old API/workers before the table migration,
then start matching readers before new payload writers.

The configured provider must DKIM-sign both unsubscribe headers as required by
[RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html). Local SMTP qualification
proves headers and capability behavior, not the external provider's signature.

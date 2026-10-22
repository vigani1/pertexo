# F27 — Personal notifications and system mail

Status: delivered, including shared audiences, named subjects, one-click opt-out
and the system-mail table rename. Updated: 2026-10-18.
[Roadmap](../product-roadmap.md). Decision:
[ADR 079](../adr/079-personal-notices-and-mail.md), including its dated amendments.
History stays in git and PRs.

## Decisions

Keep one Inbox with a private per-person view, one TypeScript audience rule and
one durable system-mail queue. Reuse existing attention facts, pending tasks,
worker polling, SMTP/Resend and application-key envelope. No new service, role,
account, queue or CI job. Shared workflow alerts remain independent.

## Rules

### Notices and personal choices

- Closed kinds are workflow failure, automatic pause, connection attention,
  approaching/reached limits, approval waiting, publication review waiting and
  explicit comment mention. Failure and mention notices retain the 30-day window;
  operational notices describe current attention and leave when it resolves.
  Active slots being occupied is ordinary queueing, not a capacity incident.
- Owners/admins/operators see workflow failures, pauses and limits by default;
  owners/admins see connection attention. Current task eligibility owns approval
  notices, including its captured default-off starter choice. Following adds a
  workflow through run-read access and grants no other capability. Publication
  reviews use current governance eligibility. F19 mentions select one current
  workflow reader, without copying comment text or adding another recipient queue;
  unchanged edits/resolution/retry never notify again. See the
  [F19 plan](19-collaboration.md) and ADR 079's 2026-10-18 amendment.
- Follow/mute are private and independent. Muting hides that subject's notices
  and personal email, including approval notices, but never resolves/hides the
  underlying task from task lists or changes shared alerts. Requested input stays
  in Requests rather than duplicating approval cards or adding an email kind.
- `inbox/eligibility.ts` owns the complete notice predicate before pagination,
  counts/revisions/read commands and mail limits. It derives roles from policy
  and reuses `runs/pending-tasks/responses/eligibility.ts`. SQL keeps workspace/active-member
  isolation and private-state fences, not another notice audience function.
- Captured task details are eligible authenticated reads only. No task context,
  input/output, variable values, credentials, provider errors or comments enter
  notice email, stream hints, safe error-workflow summaries or audit payloads.
- Existing bounded observation/folding may coalesce brief operational transitions;
  it is not an exhaustive event ledger. Removal clears private state; suspension
  preserves choices while stopping access/delivery. Purge also removes linked
  queued personal mail. Existing bounded retention owns cleanup.

### Scheduling and delivery

- Personal email inherits an initially Off workspace default or chooses Off,
  immediate, hourly or daily. Owners/admins manage defaults. Daily defaults to
  09:00 UTC with hour 0–23 and IANA zone. Missing local hours use the first valid
  later time; repeated hours send once. Hourly uses UTC hours.
- Immediate allows at most one batch per person/workspace/UTC minute. Digests and
  downtime produce one current-changes catch-up, not mail per missed window.
  Enabling/changing a choice or follow/mute cut does not email old history.
- Use existing durable mail configuration/key ring/sender/public origin. Local
  authentication links do not enable email. Explain unavailable mail; Off remains
  usable. Keep security-mail priority and one pending notice batch per person.
- `system_mail_deliveries` is the existing shared global queue, with its existing
  role/column grants. Linked notice batches/items retain workspace isolation.
  Witness at most 100 changed subjects, display at most 25 notices and cap names at
  64 Unicode code points. Plaintext stays within 12,288 bytes, including headers'
  URL; fewer rendered items preserve that bound when discussion links need space. Subjects name the workflow/connection and workspace; digests name their
  first non-limit subject and count, or the workspace for limit-only batches.
- Recipient preparation reads workspace name in its existing query. One owner
  clips/removes control/line separators for body/subject names. Sealed payloads
  contain only safe names, kinds/counts and own-origin links.
- Recheck current workspace/user/member incarnation, verified email, preference/
  default revisions and every subject immediately before dispatch. Definitive
  pre-dispatch supersession releases the reservation for later eligible content.
  A possible SMTP delivery stays in reconciliation and is never auto-repeated.
- Optional sealed `unsubscribeUrl` supplies exactly two standard headers through
  MailComposer's documented headers and Resend's headers property. No arbitrary
  header API. Older queued payloads remain readable; durable AAD, provider keys
  and maintenance rule identities retain their original strings.

### Unsubscribe

- Reuse the existing encrypted capability bound to one person/workspace,
  preference revision, membership incarnation and 90-day expiry. Opt-out affects
  personal email only. Repetition is idempotent; an old link cannot undo later
  opt-in or affect a new membership. Retired/invalid/expired keys fail clearly.
- Human body links use the fragment confirmation page and redacted header command.
  Standard headers use POST `/v1/notifications/unsubscribe/one-click?token=...`
  with URL-encoded or multipart content within 8 KiB. The URL token authorizes
  the command; body contents are ignored without parsing. No cookies, session,
  CSRF secret or POST redirect. Manual GET only gives a 303 to the existing
  same-origin fragment confirmation; it never opts out.
- Fastify's native bounded raw-body reader collects bytes, with no Busboy or
  custom multipart parser. Better Auth receives its original form bytes;
  other API routes gain no multipart support. All responses are
  no-store/no-referrer. Existing fail-closed public limiter is 30/IP/minute.
- The beta Caddy edge routes this endpoint directly to the API, bypassing nginx
  request/error logs. Its runtime filter redacts query tokens, request headers
  and redirect Location, including upstream failures. Other proxy/SSE/HSTS stays.
- The configured relay must DKIM-sign both `List-Unsubscribe` and
  `List-Unsubscribe-Post` under [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html).
  Local SMTP proves bytes/command behavior, not an external provider's signature.

## Slices and status

| Slice | Status |
| --- | --- |
| Subject notices, preferences, observation and personal UI | Complete |
| Durable notice preparation/authorization and SMTP/browser proof | Complete |
| One TypeScript audience owner and SQL isolation fence | Complete (#307) |
| Buildable mail-schema area move | Complete, separate move commit |
| Named subjects, standards opt-out, table rename and operator guidance | Complete, migration 0017 |

Qualification covers populated upgrades/grants/isolation, audiences before list
limits, DST/downtime, stale revisions, purge, maximum Unicode envelope, legacy
queued mail, raw SMTP/Resend headers, anonymous opt-out and real browser/SQL
proof. The cached Caddy/nginx probe verifies exact POST, inert manual GET and
API-down 502 log privacy. Required checks and existing CI gate rebase merge.

## Rollout and later work

Stop old API/workers before removing SQL audience rules or renaming the delivery
table. Migrate once and start matching readers before new payload writers. Keep
keys separately from backups and preserve uncertain delivery state. Custom
proxies must protect capability request/error logs too. See the
[notification guide](../guides/notifications.md) and
[single-server operations](../operations/single-server.md).

Chat/push channels, public decisions, incident management and marketing mail are
later work. Do not create placeholder transports or a second Inbox.

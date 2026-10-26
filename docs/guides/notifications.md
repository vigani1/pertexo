# Personal notifications

The Inbox combines failing workflows, auto-paused workflows, connections needing
attention, approaching workspace capacity, reached queue/file limits, waiting
approvals, publication reviews and private comment mentions. Failure threads
keep their 30-day lanes. Operational cards describe current attention and leave
when it resolves. A full active-run allowance is ordinary queueing, not a limit
notice; its 80% approaching-capacity warning is separate. See [Usage and trends](usage.md). Reading a notice changes only your own read state.

Owners, admins and operators see workflow failures, pauses and limits by default.
Owners and admins see connection attention. Approval cards use the task's actual
allowed people. Its starter is excluded unless that step explicitly allows
starter decisions. The Approvals list and authenticated task
page remain authoritative; email never approves or rejects anything. Input
requests stay in the Inbox's Requests section, without duplicating approvals.
Comment mentions are visible only to the selected member with current workflow
read access. Self-mentions are quiet; editing text or resolving/reopening a thread
never repeats the mention. Their notices expire after thirty days while comments
remain available. See [Collaboration](collaboration.md).

In a workflow's Settings, choose **Personal notifications…** to follow or mute it.
Every member can follow through existing run-read access; following grants no
other permissions. Connection detail has the same personal mute control. A mute
hides associated Inbox cards and prevents their personal email, including waiting
approval notices for a muted workflow. It never cancels a task, changes another
member's view or disables shared workflow alerts.

## Email choices

Open **Notifications** under workspace administration. Your email can inherit
the workspace default or be Off, immediate, hourly or daily. Owners/admins manage
the default; it starts Off. Daily defaults to 09:00 UTC and accepts an hour from
0–23 plus an IANA timezone such as `Europe/Paris`. Immediate messages are bounded
to one per workspace/person/UTC minute; hourly digests use UTC hours.

Email covers future changes after enabling it, changing an inherited default, or
following/unmuting a subject. It does not backfill old failures. A nonexistent
local daily hour uses the first valid time after the clock jump. A repeated hour
is used once. After downtime, one current-changes digest catches up; missed
windows do not create a mail backlog. A catch-up uses the current day's/hour's
reservation.

Notification email needs the existing durable system-mail configuration. Local
authentication links printed to the console do not enable it. Settings explains
when mail is unavailable, and turning email Off remains possible. The API and
worker use the existing `AUTH_MAIL_FROM`, `AUTH_MAIL_KEY` versioned key ring,
`PUBLIC_WEB_ORIGIN` and `SYSTEM_MAIL_TRANSPORT` settings. See the existing SMTP
and deployment guides for transport configuration. Deployed workers require the
shared sender/origin too; the single-server and ECS definitions pass them.

Subjects name the workflow or connection and the workspace. Digests name their
first workflow/connection and the number of notices; a limit-only message names
the workspace. Mail contains safe names, notice kinds and counts, plus links on your own Pertexo
origin. It contains no run input/output, variable values, provider error messages,
credentials, task instructions or comments. Messages show up to 25 notices with
bounded names (fewer when their links need the remaining envelope) and link to the Inbox for more. A batch witnesses at most 100
changed subjects and fits the existing application envelope's 12 KiB plaintext
bound; excess work continues in later passes/windows.

Current membership, verified email, preferences and every included subject are
checked again just before sending. A message that loses eligibility is canceled
before SMTP DATA and eligible content can be prepared later. A message that may
already have reached SMTP is kept for reconciliation and is never automatically
sent again. Notification email is best effort; use the Inbox and task lists when
mail cannot be delivered.

## Unsubscribe and membership changes

Each notice email links to a plain confirmation page. Opening it has no side
effect. The explicit button turns only your personal workspace email Off;
authentication mail, invitations, shared alerts and pending tasks remain.

Mail clients can also offer their own **Unsubscribe** action through the standard
`List-Unsubscribe` and `List-Unsubscribe-Post` headers. That sends an anonymous
one-click POST to your own Pertexo origin. A client that follows the header URL
with GET only opens the same confirmation page; it never changes preferences.

The encrypted capability expires after 90 days and is bound to your preference
and membership revisions. The human link uses a URL fragment and a redacted
header. The standards endpoint uses a query token, so reverse proxies must redact
that parameter and avoid logging its redirect Location or request headers. The
single-server Caddy configuration routes it directly to the API, bypassing nginx
request/error logs. Never put that capability in analytics or a query-cache key. Invalid, expired, superseded or retired-key
links explain that you can sign in and use Notification settings. Old links
cannot undo a later opt-in or affect a new membership. Public unsubscribe has its
own fail-closed limit of 30 requests per minute per client address.

Removing/leaving a workspace clears private preferences, follows/mutes and reads.
Suspension preserves choices while stopping access and delivery. Workspace purge
also removes linked personal mail, and notice/mail retention remains bounded.

Shared workflow alerts retain their existing destinations and behavior regardless
of personal choices. Public approval actions, chat/push channels, marketing mail
and per-application frequencies are outside this feature.

## Email from workflow steps

This page covers your own notices. A workflow emails people with its **Send
email** step, which can also attach files from earlier steps: see
[Attach files to an email](files.md#attach-files-to-an-email).

## Mail operator requirements

For mail-client one-click actions, configure your relay to DKIM-sign both
`List-Unsubscribe` and `List-Unsubscribe-Post` headers, as required by
[RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html). Pertexo supplies the
headers; your relay owns its signature. A local SMTP test does not certify an
external provider's signing configuration. Production uses your HTTPS public
origin. If you use another proxy, protect both successful and error logs for
`/v1/notifications/unsubscribe/one-click?token=...`, including any Location header.

The shared durable mail table is `system_mail_deliveries`. Upgrade with the
existing coordinated procedure: stop old API/workers, apply migration 0017,
then start matching readers before producing new notification payloads. Queued
ciphertext, lease/reconciliation state, role grants and provider retry identities
are preserved. Do not restart older binaries against the renamed table.

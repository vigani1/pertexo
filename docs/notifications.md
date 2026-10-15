# Personal notifications

The Inbox combines failing workflows, auto-paused workflows, connections needing
attention, workspace queue/file capacity and waiting approvals. Failure threads
keep their 30-day lanes. Operational cards describe current attention and leave
when it resolves. A full active-run allowance is ordinary queueing, not a limit
notice. Reading a notice changes only your own read state.

Owners, admins and operators see workflow failures, pauses and limits by default.
Owners and admins see connection attention. Approval cards use the task's actual
allowed people and exclude its starter. The Approvals list and authenticated task
page remain authoritative; email never approves or rejects anything. Input
requests stay in the Inbox's Requests section, without duplicating approvals.

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

Mail contains safe names, notice kinds and counts, plus links on your own Pertexo
origin. It contains no run input/output, variable values, provider error messages,
credentials, task instructions or comments. Messages show up to 25 lines with
bounded names and link to the Inbox for more. A batch witnesses at most 100
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

The encrypted capability expires after 90 days and is bound to your preference
and membership revisions. It is carried in a URL fragment and a redacted header,
not a query string or query-cache key. Invalid, expired, superseded or retired-key
links explain that you can sign in and use Notification settings. Old links
cannot undo a later opt-in or affect a new membership. Public unsubscribe has its
own fail-closed limit of 30 requests per minute per client address.

Removing/leaving a workspace clears private preferences, follows/mutes and reads.
Suspension preserves choices while stopping access and delivery. Workspace purge
also removes linked personal mail, and notice/mail retention remains bounded.

Shared workflow alerts retain their existing destinations and behavior regardless
of personal choices. Public approval actions, chat/push channels, marketing mail
and per-application frequencies are outside this feature.

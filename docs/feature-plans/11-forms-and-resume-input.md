# F11 — Forms and requested member input

Status: implementation authorized by the owner's sequential feature request.
Updated: 2026-10-15. Parent: [product roadmap](../product-roadmap.md).

## Current code and outcome

F10 merged in #301. `database/src/runs/pending-tasks/` now owns durable human
waiting, current audience, expiry, one-winner commands, capacity/budget suspension,
cancellation, retention and ordinary outbox wakeups. `core.approval` declares a
task in a short successful attempt; typed task facts settle the logical step.
Reuse that mechanism for Request input. Do not add another task table or worker.

Published graphs already own immutable step configuration. Common
`runs/commands/acceptance.ts` atomically admits a version/input with a checkpoint,
receipt and outbox; manual and Error-workflow starts use it directly. Forms need
no scheduled trigger scanner, reconciliation worker or persistent submission copy.
The form in the currently published graph is its versioned schema; admitted run
input is the retained submission. Existing Redis rate limiting and cookie/CSRF
contracts supply the transport boundaries.

Deliver a Form trigger that starts a run from a workspace member or, explicitly,
anyone holding an enabled public link. Deliver a Request input step that asks a
current eligible member for values and continues once. No file fields, email,
public mid-run responses, arbitrary HTML, CAPTCHA, extra service or account.
Choices below are recommended and accepted under the owner's autonomous mandate;
ADR 077 records the durable field/submission/public-capability contracts.

## Fields and values

- Shared browser-safe model in `workflow-model/src/forms/`: strict ordered fields,
  title, instructions and one submission validator. Maximum 20 fields; unique
  stable names matching `[A-Za-z][A-Za-z0-9_]{0,63}`, excluding prototype names.
  Labels are 1–160 characters, help text up to 500, plain text throughout.
- Types: short text, long text, email, finite number, boolean, single select,
  date (`YYYY-MM-DD`). Required defaults true. Single select has 1–50 unique
  nonempty options, each at most 160 characters. No free-form pattern language,
  calculations, conditional visibility, dynamic field schemas or custom scripts.
- Text/email values are strings up to 10,000 characters; email additionally uses
  the existing email validation convention. Number accepts finite JSON numbers,
  boolean accepts true/false, date must be a real Gregorian calendar date, and
  select must match an option. An optional blank field is omitted. False and
  zero are present values. Do not coerce arbitrary strings into booleans/numbers.
  Browser controls produce these typed JSON values; the server owns validation.
- Reject unknown fields, nested objects, file references and oversized input.
  A normalized submission is at most 64 KiB and remains within the ordinary
  engine value envelope. Report field errors without echoing submitted values.
- Logical output is `{ values, submittedBy, submittedAt }`; member actor UUID or
  null for a public start, and a server timestamp. Trigger run input is that same
  envelope. Request input output always names its submitting member.
- Config defaults are materialized by editor creation, matching portable
  publication's existing no-implicit-transform rule. Shared validation stays in
  the model; API, executor and editor do not invent different field rules.

## Form trigger and publication

`core.form@1` lives in `nodes-core/src/triggers/form/`. It is a safe CPU trigger
that returns the supplied normalized input. There is at most one Form trigger,
in the root graph, with one `out` port. Publish validates this constraint; forms
are not available from draft schemas. The editor's usual Run action remains an
explicit member-authorized run with editable input, not a public admission path.

Member form discovery/submission requires current active workspace membership,
including viewers. This permits only the named workflow's published form; it
never grants arbitrary run, edit, history or credential access. Run reads retain
their current policy. Form settings/link management requires workflow edit access.

Use current active workflow/publication under a workflow lock. A submission carries
the displayed immutable version ID; if publication changed, return a clear stale
form conflict and preserve local fields until the person reloads the schema.
Archived, unpublished, disabled-step or missing-form workflows refuse new starts.
Already admitted runs and pending tasks continue through normal lifecycle rules.

Use common queued run admission, capacity and input/artifact validation. A stable
idempotency key plus exact normalized fields/version/actor identifies a submission;
a changed request with the same key conflicts. Do not store a second submission
payload. The run input, starter attribution, command receipt and normal advance
outbox commit together. Public responses acknowledge acceptance only: no run link,
run ID, workflow graph, workspace membership or execution data. Member responses
may link the run through ordinary authorized navigation.

## Public access and abuse

Default access is workspace members. One workspace-scoped `workflow_forms` row
per workflow stores only access mode, stable public identity, current capability
hash/revision and timestamps. Fields stay in the immutable graph. Enabling public
access generates a random 256-bit capability; only its SHA-256 digest is stored.
Disabling clears the grant immediately. Regeneration invalidates the old grant.
The full URL is shown once after enable/regenerate; no stored plaintext secret,
encryption provider or new master key. Explain that losing it requires regeneration.

Public page URL uses `/forms/:publicId#<capability>`: the browser fragment avoids
putting the capability into server access logs or normal Referer URLs. API calls
send it in a dedicated redacted header, never query strings or audit metadata.
No-store responses and no-referrer page behavior; no third-party form resources.
Use the existing same-origin JSON transport/CORS policy; no credentialed public
capabilities in email. A public endpoint does not interpret a session cookie as
an authorization fallback.

A narrow security-definer discovery function maps a matching public ID/digest to
workspace/workflow IDs only, following existing webhook ingress discovery. Fixed
search path, PUBLIC revoke, explicit existing-role execute grant. All schema reads
and admissions then enter a normal tenant transaction and recheck/lock the grant,
workflow and current publication. Disabling/rotating and submitting have one
linearization point; cached lookups cannot authorize acceptance. Invalid, disabled
or foreign grants receive the same unavailable response.

Extend existing Redis policy with form-read and form-submit classes, including
trusted client IP and form identity, plus workspace limits after valid discovery.
Recommended per-minute ceilings: reads 60/IP and 300/form; submissions 10/IP,
30/form and 60/workspace. Public writes fail closed when rate limiting is down;
quota/overload refuse admission without storing submission content. No CAPTCHA or
new rate-limit service. Existing workspace queue/capacity fences still apply.

## Requested input on F10 tasks

`core.request-input@1` in `nodes-core/src/flow/request-input/` has the same form
fields, title/instructions, expiry (default seven days; 1 hour–30 days), and F10's
roles/named-member audience. Default owners/admins. The initiating person **may**
respond to a Request input task; Approval's self-decision prohibition stays intact.

Extend the closed pending-task kind with `input_request` and terminal status
`submitted`, with a typed captured form schema/result. No generic plugin payload.
The pure engine accepts a scoped submitted fact, produces a task-owned output
reference and selects `out`; existing expiry/capacity failure pairs and failure
links apply. Declaration attempts, restart, cancellation, loop pruning, parallel
quiescence and Call clocks keep one implementation. Publication fences named
members in both kinds, including loop bodies.

A `/pending-tasks/:taskId/submit` member command locks current authority, run and
task, validates values against its captured schema and expiry, then records one
winner, plain audit identity and the normal run/ancestor wakes in that transaction.
No public task capability. Same-key recovery retains the exact request and key;
competing responses cannot replace the first output. Do not duplicate values in
audit, notices or command receipts. Values follow normal run-detail retention,
workspace purge and authorized output reads. F09 step recovery remains unavailable
for human-task graphs; replay creates a fresh request.

## Placement and frontend

- `workflow-model/src/forms/` owns fields/config/value validation; existing
  `pending-tasks/` owns the closed human task kinds and audiences.
- `nodes-core` registers both definitions; the browser catalog advertises logical
  submitted output and hides private pending markers. Engine adds only the exact
  submitted transition, retaining its existing task owner.
- `database/src/triggers/forms/` owns published-form reads, access grants and
  common admission; existing `/triggers` export. `schema/triggers/` (group before
  adding a long flat area if needed) owns additive Drizzle schema/migration,
  forced RLS, existing-role grants and bounded public discovery. No extra entry
  point or dependency. `runs/pending-tasks/` owns responses and current authority.
- `contracts` owns form discovery/settings/submission and typed stale/validation/
  unavailable errors. `apps/api/src/forms/` is one Nest boundary composed into
  existing runtime; public routes have explicit rate limiting and no auth fallback.
- Web `features/forms/` owns the field editor, renderer, API/query/command modules
  and isolated hosted/member pages through deliberate public exports. Reuse the
  same accessible controls in the step inspector and requested-input page.
- Rename `features/approvals/` to `features/pending-tasks/` in a **move-only commit**
  before shared UI logic. Move inspector Approval controls to `human-task/` and
  the shared model audience to `pending-tasks/audience.ts` in that same mechanical
  commit, retaining behavior. Keep the Approval route and links usable; a Requests
  view includes input tasks while Approval remains filterable. Inbox and run
  history compose that shared owner; no second polling store or pending-task UI.
- Static imports use focused public entry files, pages stay lazy. Server state is
  TanStack Query, unsent fields stay local, filters are URL state. Preserve input
  and stable command keys after uncertain responses; one visible feedback owner.
- Weft Status/thread pieces, plain labelled forms, inline errors and keyboard/
  phone/reduced-motion support. Public completion states reveal no run details.
  Link settings show enabled/disabled and the one-time copy/regenerate behavior.

## Delivery and evidence

One F11 PR after #301, with moves in separate buildable commits. No deployment,
provider account, paid service, new package, role, queue, CI job or infrastructure.
Update existing CI real-stack browser journeys; no new job.

- [x] Reconcile merged F10 and current publication/admission/HTTP boundaries.
- [x] Record recommended field, access, retention and response choices; ADR 077.
- [ ] Shared fields, Form and Request input nodes, pure engine submitted facts.
- [ ] Grants/admission and task response transactions; forced RLS and purge.
- [ ] HTTP discovery, publication conflict, validation, idempotency, rate limits.
- [ ] Editor fields, member/public forms, link controls, inbox and input response.
- [ ] Real database races: changed publication, disable/rotate, duplicate submits,
      membership loss, foreign IDs, task expiry/cancel and one winning response.
- [ ] Real worker: Form → Request input → downstream mapped output, restart,
      handled expiry and exactly one continuation; public starts have no actor.
- [ ] Desktop/phone/keyboard browser journeys against real API/worker; safe public
      completion, invalid fields, uncertain responses and dynamic publication.
- [ ] Lint, types, units, build, mocked e2e, contracts/schema/architecture/Knip,
      changed React Doctor, inspected screenshots and owned-fixture cleanup.
- [ ] PR green, rebase merged; inspect natural main result.

## Rollout, rollback and later work

Matching API/worker readers precede publishing either definition. Disable public
access before removing ingress; settle/cancel existing input tasks and retain
compatible history readers before rolling back task support. Existing submitted
run data follows run/input/detail retention, not an independent indefinite inbox.

Later: file fields, public mid-run input, email links, CAPTCHA if actual abuse
requires it, conditional fields, richer validation and form theming. No extra
machinery is built for those now. F13 variables and F27 preferences follow only
after this feature is implemented and merged.

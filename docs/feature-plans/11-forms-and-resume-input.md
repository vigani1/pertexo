# F11 — Forms and requested member input

Status: complete; merged in #302 and natural main qualification passed.
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
  Each field also has an immutable local ID, separate from its editable data name,
  so renaming and reordering preserve focus and control state. IDs are unique
  within that form, 1–64 ASCII letters/digits/underscore/hyphen.
  Labels are 1–160 characters, help text up to 500, plain text throughout.
  Text must be valid Unicode without null characters, matching PostgreSQL JSON
  storage; emoji are supported. Invalid text fails before any admission write.
  Field definitions together fit 10 KiB, leaving room for audience and
  instructions inside the existing 16 KiB durable task configuration fence.
  The complete Request input setup also validates that 16 KiB budget, including
  escaped Unicode/control characters and its audience, before publication.
- Types: short text, long text, email, finite number, boolean, single select,
  date (`YYYY-MM-DD`). Required defaults true. Single select has 1–50 unique
  nonempty single-line options, each at most 160 characters. No free-form pattern language,
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
are not available from draft schemas. The editor's run action opens the published member form for a Form workflow.
Ordinary Manual/API start refuses a Form version with an explicit “use the form”
response, so a caller cannot forge the form's server-owned submitter/timestamp.
Other workflow starts retain their existing behavior; replay retains the original
submission envelope and binds its new initiating person as usual. For a Form
version, replay requires the exact source version and input; changing either
uses a new form submission. The common admission transaction enforces this,
preventing replay from inventing a form submitter or submission time. Expired
captured input cannot be replayed even if its row awaits physical cleanup. The
replay dialog shows known Form input as read-only and links to the current form
for a new response; server refusal also explains this for an unreadable version.

Member form discovery/submission requires current active workspace membership,
including viewers. This permits only the named workflow's published form; it
never grants arbitrary run, edit, history or credential access. Run reads retain
their current policy. Form settings/link management requires workflow edit access.

Use current active workflow/publication under a workflow lock. A submission carries
the displayed immutable version ID; if publication changed, return a clear stale
form conflict and preserve local fields until the person reloads the schema.
Archived, auto-paused, unpublished, disabled-step or missing-form workflows refuse
new starts. Form outcomes participate in the existing automatic pause policy.
Already admitted runs and pending tasks continue through normal lifecycle rules.

Use common queued run admission, capacity and input/artifact validation. A stable
idempotency key plus exact submitted fields/version/actor identifies a submission;
a changed request with the same key conflicts. Do not store a second submission
payload. The run input, starter attribution, command receipt and normal advance
outbox commit together. A public start has no authenticated human starter, like a webhook. Approval
cannot exclude an anonymous sender from later member decisions; use member-only
access when that independence must be enforced for the submitting person.

Public responses acknowledge acceptance only: no run link,
run ID, workflow graph, workspace membership or execution data. Member responses
may link the run through ordinary authorized navigation.

## Public access and abuse

Default access is workspace members. One workspace-scoped `workflow_forms` row
per workflow stores only access mode, stable public identity, current capability
hash/revision and timestamps. Fields stay in the immutable graph. Enabling public
access generates a random 256-bit capability; only its SHA-256 digest is stored.
Disabling clears the grant immediately. Regeneration invalidates the old grant.
A publication that removes, replaces or disables its Form entry revokes the
public grant in that same transaction; reintroducing a Form never silently
resurrects the old link. The grant also binds its exact entry node identity.
The browser generates the capability with Web Crypto and retains its exact
command/key through an uncertain response. The server stores only its digest;
the idempotency receipt contains grant identity/revision, never the capability.
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

`core.request_input@1` in `nodes-core/src/flow/request-input/` has the same form
fields, title/instructions, expiry (default seven days; 1 hour–30 days), and F10's
roles/named-member audience. Default owners/admins. The initiating person **may**
respond to a Request input task; Approval retains its captured starter choice (default off; ADR 076).

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
- [x] Shared fields, Form and Request input nodes, pure engine submitted facts.
- [x] Grants/admission and task response transactions; forced RLS and purge.
- [x] HTTP discovery, publication conflict, validation, idempotency, rate limits.
- [x] Editor fields, member/public forms, link controls, inbox and input response.
- [x] Real database races: changed publication, disable/rotate, duplicate submits,
      membership loss, foreign IDs, task expiry/cancel and one winning response.
- [x] Real worker: Form → Request input → downstream mapped output, restart,
      handled expiry and exactly one continuation; public starts have no actor.
- [x] Desktop/phone/keyboard browser journeys against real API/worker; safe public
      completion, invalid fields, uncertain responses and dynamic publication.
- [x] Lint, types, units, build, mocked e2e, contracts/schema/architecture/Knip,
      changed React Doctor, inspected screenshots and owned-fixture cleanup.
- [x] PR green, rebase merged; inspect natural main result.

## Local qualification

The final isolated full run passed lint, TypeScript and all 9,127 Vitest tests,
plus native test scripts. Real PostgreSQL passed 30 Form/pending-task cases and
seven existing acceptance/security/schema cases. Real worker proofs cover
Form → Request input → mapped Stop, restart with one continuation, and expiry
handled by a failure link. The engine human-task group passed all 14 cases.

The real API/worker/browser journey passed at desktop 1280 and phone 375 with
reduced motion, keyboard response, field rename/reorder focus, member/public
submissions, trusted actor/time, CSRF and typed-value refusals, manual-start
refusal, revocation, and independent SQL checks of downstream values and audits.
Inspected synthetic screenshots are in `docs/media/forms/` (filled form before
submission and receipt after submission). Public receipts contain no run identity.
The mocked suite passed all 172 browser cases, including exact lost-acknowledgement
retry and stale-schema input preservation. React Doctor on changed React files: 100/100, no findings; no suppressions added.

Qualification caught and fixed declaration materialization for the single-output
input step, browser byte inspection using Node Buffer, unpublished sharing-cache
invalidation, and the test fixture missing its existing notifications runtime.
Simultaneous real-browser builds and unit runs produced editor lazy-load timeouts;
the complete isolated run passed without extending those test deadlines. Live and
mocked browser builds must run serially because both own the same Vite output.

The initial documentation commit accidentally staged Approval-file deletions.
The following commit restored them before the separate move commit. History was
preserved; the final tree contains the intended moves and shared task owner.

## Rollout, rollback and later work

### Follow-up: mapped context and prefills (2026-10-15)

Status: implemented; qualification and merge evidence are recorded in its PR.

Request input accepts the same mapped `details` fields and immutable task context
as Approval (F10 follow-up). It also accepts optional mapped `prefill` values keyed
by form field name. Validate each supplied value using the existing field rules,
but allow required fields to be absent: prefills are a starting point, not a
submission. Reject unknown names or invalid types/options; do not coerce values.
The existing 64 KiB form-value budget applies, with a 72 KiB conservative JSON
storage fence for complete context. A bad mapping fails declaration clearly and
never opens a partial task. Prefills are captured once, remain editable on the
response page, and never overwrite the responder's unsent edits on refetch.
Submission still validates every required field against the captured schema.

Use ordinary input mapping controls (`details`, `prefill`), not a second mapping
language or browser evaluation. FormResponse initializes its local controls from
the saved prefills once; public/start forms are unaffected. Input-request Inbox
rows show captured details, with no extra per-row fetch. Tests cover typed zero
and false, optional omissions, invalid/unknown fields, immutable capture through
restart, corrected responder values and an unchanged idempotent continuation.

Real member/public starts now qualify mapped details and editable prefills before
continuing once; independent SQL checks the unchanged captured values after
submission. Screenshots are in `docs/media/task-context/`.

Matching API/worker readers precede publishing either definition. Disable public
access before removing ingress; settle/cancel existing input tasks and retain
compatible history readers before rolling back task support. Existing submitted
run data follows run/input/detail retention, not an independent indefinite inbox.

Later: file fields, public mid-run input, email links, CAPTCHA if actual abuse
requires it, conditional fields, richer validation and form theming. No extra
machinery is built for those now. F13 variables and F27 preferences follow only
after this feature is implemented and merged.

## Merge evidence

PR #302 rebase merged as `0eaa5ac4409a7bafe15b91445f7adb9952fad083`.
CI 38732419684 passed all required jobs, including the real browser batch;
CodeQL 38732419735 passed. Natural main CI 38735773347 passed every job, including ARM image publication;
CodeQL 38735773344 also passed.

## Shared trigger ownership (2026-10-15)

Form is part of the single supported-trigger definition in
`workflow-model/src/graph/triggers.ts`; model graph checks and engine input
handling consume it. Form admission, replay and submission behavior is unchanged.

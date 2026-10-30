# ADR 077: Published forms and member input tasks

- **Status:** accepted under the owner's autonomous feature instruction
- **Date:** 2026-10-15
- **Plan:** [F11](../feature-plans/11-forms-and-resume-input.md)

## Context

Forms accept untrusted member/public values to start runs. Requested member input
must resume the exact waiting invocation rather than start another run. F10 has
one durable task/checkpoint/outbox boundary; common admission already persists
immutable version and input without a second submission store.

## Decision

An immutable published Form node owns its strict bounded ordered field schema.
Each field has a stable local ID distinct from its editable output name, preserving
control identity through renames/reordering without using array indices as keys.
Submissions bind the displayed version and reject changed publication, inactive
workflow and invalid/unknown/oversized fields. One common admission transaction
records normalized `{ values, submittedBy, submittedAt }` input, starter, receipt,
checkpoint and ordinary outbox. No duplicate submission payload or new worker.
Manual/API start cannot bypass submission. Form replay requires its source version
and exact captured input; changing either starts through the form again, preserving
server ownership of the recorded submitter and time.

Member access is default and requires current active membership. Explicit public
access uses a random 256-bit bearer capability, stored only as a digest in a
workspace-scoped workflow grant. A browser-fragment link supplies a redacted API
header; disable/regenerate invalidates old capabilities atomically. A narrowly
granted discovery function returns workspace/workflow identity only; every actual
read/admission rechecks the grant and current workflow inside tenant isolation.
A grant binds its exact entry node; removing, disabling or replacing that entry
revokes it in the publication transaction. Public completion reveals acceptance,
never run history or data. Existing Redis
rate limiting fails closed for public writes, alongside ordinary capacity fences.

Request input extends ADR 076's closed pending task with a captured form schema
and a submitted outcome. Only a current eligible member may submit, once, before
expiry and while the run remains live. The starter may supply requested input;
Approval retains its captured starter choice (default off; ADR 076). The same task store, engine facts,
result references, clocks, capacity, cancellation and retention own both kinds.
Responses become ordinary authorized step output; audits/receipts omit values.
F09 prefix recovery remains unavailable for these human graphs.

## Consequences

### Amendment: captured prefills (2026-10-15)

Request input captures mapped details and optional typed prefills when its task
opens, reusing ADR 076's context column. Prefills use the captured field schema's
normal validator, except that a required field may be absent until submission.
Unknown names and invalid supplied values fail declaration. Stored prefills never
change and do not replace unsent edits when the browser refreshes the task.
Submission remains a separately validated, one-winner member response. Start forms
and public capabilities retain their existing behavior.

Forms have one immutable schema and one retained submission, with explicit public
revocation and safe stale-schema behavior. Input requests reuse durable human
waiting without another service or task mechanism. Public links are shown once;
losing one requires regeneration. Schema and capability readers require additive
migration and matching API/worker rollout. No files, email, anonymous mid-run
response, arbitrary HTML/scripts, CAPTCHA or new infrastructure is introduced.

### Amendment: acceptance messages and multiple choices (2026-10-16)

A Form trigger may configure a plain thank-you message of 1–1,000 characters;
absence uses “Thanks for your response.” Preserve absence in older graph setup
so portable export/import remains exact. Submission responses carry the accepted
immutable version's message, including same-key retries after publication changes.
Reuse the existing acceptance receipt and its version-bound request hash; no
second receipt, submission table or receipt-format change. Public responses still
omit run identity. The message confirms acceptance, not successful execution.

`multi_select` extends the shared bounded choice field with arrays of unique
configured strings. Required means at least one choice; an optional empty array
is omitted. API order is retained and the UI submits configured option order.
The same validator serves Form admission and Request input, including captured
prefills. Existing field, definition, response and task-context budgets remain.
Only Form triggers have the thank-you setting. Matching API/worker readers must
precede publishing new setup or field types; old graphs and outputs remain valid.

### Amendment: authoring, selection bounds and destinations (2026-10-16)

Request input shares ADR 076's detail rows and adds field-labelled prefills with
the same picker. Prefills are partial: supplied selections may be below the
field's minimum, but must fit its maximum and configured choices. Final responses
must meet both limits. Multi-select optionally configures `minSelections` (0–50)
and `maxSelections` (1–50), with minimum no greater than maximum and maximum no
greater than the option count. Required fields still need at least one choice;
optional empty selections omit the field. Missing limits preserve legacy behavior
and remain absent in old portable configuration. One shared form validator owns
submission rules for browser and API.

Only a Form trigger may configure `redirectUrl`: a fixed HTTPS URL up to 2,048
characters, without embedded credentials. No expressions, submitted values,
capabilities or run IDs are appended. Discovery omits it; the accepted receipt
returns the URL from the exact version that accepted the command, including
idempotent retries after republication. Navigate only after confirmed acceptance,
using replacement navigation; uncertain or rejected submissions keep their form.
Public pages retain their no-referrer policy and show no run identity.

Thank-you messages remain escaped plain text. Auto-link only validated HTTP(S)
URLs without credentials; use ordinary anchors with no opener or referrer.
Never interpret HTML, markdown or other URL schemes. A form may omit a redirect
and show its normal receipt and links. Request input has neither destination nor
thank-you configuration. Start matching readers before publishing these optional
configuration fields; no new stored-format version, service or role is required.

### Amendment: file questions (2026-10-26)

The owner approved [F52](../feature-plans/52-form-file-uploads.md) on
2026-10-26. Forms and Request input gain a shared `file` field (accepted kinds,
1–5 files, at most 10 MB each), replacing this ADR's "no files". Responses name
upload IDs; admission swaps them for ordinary file references, so a form value
is a list of `{ file, filename }`. The responder's file name is a stored label
here, an exception to ADR 075's transient-filename rule like multipart part
names: the last path part only, without control characters, up to 255
characters, never used to choose storage or format.

Uploads reuse the artifact transfer and its reservation, idempotency, capacity
and cleanup. A `form-upload` artifact is bound in `form_uploads` to its
published version or task, field, response session digest and the link
capability digest or uploading member. A submission resolves only bound,
available, unexpired uploads. Unsent files expire after one day, or one hour
through a public link; references in run input or an answered task retain them
like any execution fact. Public uploads spend the form read budget and a
per-client, per-link and per-workspace upload budget, and unsent public files
share a 100 MiB allowance per workspace; acceptance marks a response's files
sent. Finalization verifies size and SHA-256 and sniffs the leading
bytes against the extension; files are still never scanned, parsed or rendered
outside an explicit step.

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

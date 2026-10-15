# Forms and requested input

A **Form** trigger starts a workflow from a structured response. Add it as the
only entry step, configure its title and fields, then publish. The editor's
**Form** action opens the currently published member form. Changes to the draft
apply after publishing. A person viewing an older form must reload before sending;
their typed values remain visible until they choose to reload.

Workspace members, including viewers, can submit the member form. This does not
give viewers permission to edit the workflow or start arbitrary runs. Existing run
history permissions apply to the member's **Open run** link.

Supported fields are short/long text, email, number, true/false, one choice and date.
Names are stable mapping keys: letters first, then letters, numbers or underscores.
Use up to 20 fields, with unique names. Choice options are single-line text. Text
is plain text; no HTML, files, scripts, calculations or conditional fields.
Responses fit 64 KB; field definitions fit 10 KB. Number and boolean fields
produce real JSON numbers and booleans. Zero and false are valid values. Optional
blank fields are omitted.

For example, define `message` (long text), `amount` (number) and `currency`
(choice: EUR or USD). The next step can map `runInput.values.amount` or the Form
step's `values.currency`. The full input is:

```json
{
  "values": { "message": "Order request", "amount": 0, "currency": "EUR" },
  "submittedBy": "<member ID, or null for public submissions>",
  "submittedAt": "<server timestamp>"
}
```

The server supplies the person and timestamp. Ordinary Manual/API starts refuse
Form versions; use the form submission endpoint. Replay reuses the original
submission input and source version. To change either, send a new form response.

## Public links

An editor can **Enable public link** in the published Form setup. Anyone holding
that link can send responses. The full URL is shown once: save it securely.
Pertexo stores its digest, not its plaintext key. Losing the link requires
**Regenerate link**, which immediately invalidates the previous one. **Turn public
access off** also revokes it immediately. Replacing or removing the published
Form entry revokes its old grant; adding a Form again does not revive old links.

The key is in the URL fragment and travels to the API in a redacted header. Public
pages use no-referrer/no-store behavior. A public response confirms acceptance
without exposing a run link, run ID, workflow graph or workspace information.
Public reads and submissions have IP/form/workspace rate limits and refuse writes
when rate limiting is unavailable. Paused, archived and unpublished forms reject
new submissions. Existing workspace admission and automatic pause limits apply.
There is no CAPTCHA. Public starts are anonymous, so an Approval step cannot
identify and exclude their original sender. Use a member-only form when that
starter restriction must apply to the person sending it.

## Request input during a run

Add **Request input** after any step. It captures its title, instructions, fields
and eligible roles or named members when it starts. Owners and admins can respond
by default; expiry defaults to seven days. The person who started the run may
respond. This differs from Approval, where the starter cannot decide.

Eligible members find it in **Inbox → Requests** and the **Requests** list. One
response wins, even if two people send at the same time. Its output contains
`values`, `submittedBy` and `submittedAt`, with the same types as a Form trigger.
Map the Request input step's `values.answer` into a later step.

In **Inputs**, map `details` to named facts the responder needs, as for
[Approval details](approvals.md). Map `prefill` to an object keyed by your field
names, such as `{"answer":"Suggested response","amount":0,"ready":false}`.
Only fields present in this request are accepted; values must already have their
field's type and choice options. Required fields may be missing from prefills,
but must be completed before sending. Prefills fit the existing 64 KB response
budget. Both details and prefills are captured once when the task opens. The
responder can edit prefills, and refreshing task data never replaces unsent edits.

The run releases its active slot and pauses its execution budget while only human
tasks are pending; an explicit absolute deadline still applies. Request expiry
fails the step and can follow its failure link. Cancellation closes the task.
Restarting the worker preserves the pending task and captured fields. Inputs stay
with ordinary run detail retention; no second submission store or copy in audit.

Responses require current workspace membership and audience eligibility. There are
no public mid-run responses or email links. If sending has an uncertain outcome,
use **Retry same response** before changing it; this retains the original command
and cannot create a second run or overwrite another person's response.

Later work: file fields, public mid-run input, email links, conditional fields and
richer validation. These are not available in this release.

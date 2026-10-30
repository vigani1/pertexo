# Forms and requested input

A **Form** trigger starts a workflow from a structured response. Add it as the
only entry step, configure its title and fields, then publish. The editor's
**Form** action opens the currently published member form. Changes to the draft
apply after publishing. A person viewing an older form must reload before sending;
their typed values remain visible until they choose to reload.

Workspace members, including viewers, can submit the member form. This does not
give viewers permission to edit the workflow or start arbitrary runs. Existing run
history permissions apply to the member's **Open run** link.

Supported fields are short/long text, email, number, true/false, one choice,
multiple choices, date and file (see [File questions](#file-questions)).
Names are stable mapping keys: letters first, then letters, numbers or underscores.
Use up to 20 fields, with unique names. Choice fields allow 1–50 unique single-line options. Text
is plain text; no HTML, scripts, calculations or conditional fields.
Responses fit 64 KB; field definitions fit 10 KB. Number and boolean fields
produce real JSON numbers and booleans. Zero and false are valid values; turn on
**Must be ticked to send** for an agreement box that only accepts a tick. Optional
blank fields are omitted. Multiple-choice values are arrays such as
`{"channels":["Email","SMS"]}`. Required fields need at least one choice; each
choice must be configured and selected only once. Optional empty selections are
omitted. The form submits choices in their configured order; API submissions keep
their supplied order. For **Choose multiple**, set optional **Minimum selections**
and **Maximum selections**. Both must fit the option count, and minimum cannot
exceed maximum. Optional fields may still be left empty. The responder sees the
limits and cannot add more than the maximum; the API enforces them too.

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

## File questions

A **File** field asks for an invoice PDF, a photo or a spreadsheet. In its setup,
choose what it **Accepts** (Documents: PDF, Word, text and Markdown; Images:
PNG, JPEG, WebP, GIF and HEIC; Spreadsheets: Excel and CSV; Data: JSON and
XML), how many **Files per response** (1–5) and the **Largest file** (1–10 MB,
5 MB by default). The same field works in a Form trigger and in Request input.

How it works:

1. The responder drops or chooses files. Each file is checked against the
   field before anything is sent, then uploaded straight to file storage and
   verified: its size, its SHA-256 and its first bytes must match the type its
   name claims. A PDF renamed from a web page is refused with
   `form.file_type_not_allowed`. A file over the limit says so in plain words,
   such as "This file is 12 MB; the limit is 5 MB."
2. Each upload is bound to that form link (or member), published version,
   field and response. A response can only use files it uploaded itself, and
   only while they are kept. **Send response** waits until every upload has
   finished.
3. The run receives each file as an ordinary file reference with its name. The
   value is always a list, even when the field takes one file:

```json
{
  "values": {
    "shop": "Corner shop",
    "orders": [
      {
        "file": {
          "kind": "artifact",
          "artifactId": "<file ID>",
          "byteLength": 20,
          "mediaType": "text/csv",
          "sha256": "<checksum>"
        },
        "filename": "orders.csv"
      }
    ]
  },
  "submittedBy": null,
  "submittedAt": "<server timestamp>"
}
```

To parse the CSV, open [Read file](files.md)'s **Insert data** and choose
**first file from** the question's label: it maps `$.values.orders[0].file`
from the run input, so it works however far the step is from the Form. Send
email's **Attach a file** offers **all files from** the label, which attaches
every uploaded file with its name. An optional file field left empty is
omitted.
Members see a response's files as download cards on the run's **Input &
output** tab and on the answered request; public responders never see other
responses' files, and download links stay member-only.

Public uploads spend the form's read limit plus an upload budget per client,
link and workspace. One response can begin at most 25 uploads. Files count
against the workspace's storage quota; a full workspace refuses new uploads
with `workspace.quota_exceeded`. Files that are uploaded but never sent are
removed by the ordinary cleanup: after an hour for a public link and after a
day for members and Request input. A sent response's files stay for as long as
its run keeps its data. Public-link files that nobody has sent yet share 100 MB
per workspace, so a stranger can't fill the workspace's storage; past that,
new public uploads get "Try again in a few minutes" (`form.upload_limit`).
Members' uploads aren't affected. Regenerating or turning off the public link
also stops unfinished uploads from being finalized. Files are not
virus-checked; treat them as untrusted, as for any [file](files.md).

## After submission

The default receipt says **Thanks for your response.** In the Form trigger's
**Thank-you message**, configure plain text up to 1,000 characters. This confirms
that Pertexo accepted the response; the workflow may still be waiting or running.
The message comes from the published version that accepted that response. Retrying
the same response after a publication change keeps its original message and cannot
start another run. Plain HTTP/HTTPS URLs become safe clickable links; embedded
credentials and other schemes are not linked. HTML is displayed as text.

Optionally set **Redirect after submission** to a fixed HTTPS address, without
embedded credentials, for example `https://example.com/thanks`. After confirmed
acceptance, the form continues there. A failed or uncertain response stays on
the form. Exact retries keep the accepting version’s destination, even after a
new publication. Pertexo never appends responses, run IDs or the public-link key.
Leave the destination empty to keep the receipt and its links. Request input
has neither redirect nor thank-you settings.

[Member form](../media/forms/member-1280-before.png) ·
[Member receipt](../media/forms/member-1280-after.png) ·
[Phone form](../media/forms/public-375-before.png) ·
[Phone receipt](../media/forms/public-375-after.png)

## Public links

An editor can **Enable public link** in the published Form setup. Anyone holding
that link can send responses. The full URL is shown once: save it securely.
Pertexo stores its digest, not its plaintext key. Losing the link requires
**Regenerate link**, which immediately invalidates the previous one. **Turn public
access off** also revokes it immediately. Replacing or removing the published
Form entry revokes its old grant; adding a Form again does not revive old links.

The key is in the URL fragment and travels to the API in a redacted header. Public
pages use no-referrer/no-store behavior. A public response confirms acceptance
without exposing a run link, run ID, workflow graph or workspace membership.
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
respond. Approval excludes the starter by default; its per-step opt-in can allow them.

Eligible members find it in **Inbox → Requests** and the **Requests** list. One
response wins, even if two people send at the same time. Its output contains
`values`, `submittedBy` and `submittedAt`, with the same types as a Form trigger.
Map the Request input step's `values.answer` into a later step.

In **Setup**, add label/value details for the responder, as for
[Approval details](approvals.md). Use **Add prefill**, choose a field, and enter
a value or use the normal picker; advanced expressions are also available.
Existing whole-object mappings stay editable in **Inputs**, such as `{"answer":"Suggested response","amount":0,"ready":false}`.
A detail may also be a short list of plain values, under the shared 8 KB limit.
A multiple-choice prefill is a choice array, for example `{"channels":["Email"]}`.
Only fields present in this request are accepted; values must already have their
field's type and choice options. Required fields may be missing from prefills,
but must be completed before sending. A prefill may have fewer than the minimum
choices, so the responder can finish it; it cannot exceed the maximum. Prefills fit the existing 64 KB response
budget. Both details and prefills are captured once when the task opens. The
responder can edit prefills, and refreshing task data never replaces unsent edits.

The run releases its active slot and pauses its execution budget while only human
tasks are pending; an explicit absolute deadline still applies. By default,
request expiry fails the step and can follow its failure link. Choose **Continue
on Timed out** under **When nobody responds** to give the step a Timed out
output instead; the run then continues there with `timedOut`, `openedAt`,
`expiredAt`, the audience and the captured details and prefills (see
[Approvals](approvals.md#how-the-timed-out-path-works)). Cancellation closes the task.
Restarting the worker preserves the pending task and captured fields. Inputs stay
with ordinary run detail retention; no second submission store or copy in audit.

Responses require current workspace membership and audience eligibility. There are
no public mid-run responses or email links. If sending has an uncertain outcome,
use **Retry same response** before changing it; this retains the original command
and cannot create a second run or overwrite another person's response.

A Request input file field works the same way: the responder attaches files on
the task page, and the step's output lists them under `values`. Steps linked
right after it offer the same **first file from** and **all files from**
choices, read from its output. Files can't be prefilled; only the responder
can upload them.

Later work: public mid-run input, email links, conditional fields and richer
validation. These are not available in this release.

## When the workflow is busy

A workflow can [queue or skip at its concurrency limit](concurrency.md).
Skipped events create no run and remain visible in trigger history and Usage.

## Coordinate submissions

The Form step supports optional [event coordination](event-coordination.md). Use
a field key such as `$.values.orderId` to deduplicate, debounce or throttle.
Pending, duplicate and refused submissions show their actual status instead of
the ordinary thank-you message or redirect. Editors see metadata in the step’s
**Coordinated form events** history. Public responses expose no run link or key.

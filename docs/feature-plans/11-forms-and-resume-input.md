# F11 — Forms and requested member input

Status: delivered, including immutable mapped prefills, thank-you messages and
multiple choices. Updated: 2026-10-16. [Roadmap](../product-roadmap.md).
Decision: [ADR 077](../adr/077-form-submission-and-input-tasks.md).
History stays in git and PRs.

## Decisions

A published Form starts a run for a workspace member or an explicitly enabled
public capability. Request input uses F10's existing pending-task mechanism for
member-only mid-run responses. Schema stays in the immutable workflow version;
accepted values stay in ordinary run input/task output. No second submission
store, worker, public mid-run response, email link or file field.

## Rules

### Fields and values

- At most 20 ordered fields with unique stable local IDs and data names. Names
  match `[A-Za-z][A-Za-z0-9_]{0,63}` and exclude prototype names. Labels are up to
  160 characters; plain help up to 500. Definitions fit 10 KiB and complete
  Request input configuration fits the existing 16 KiB task fence.
- Types: short/long text, email, finite number, boolean, single select, multi-select
  and real Gregorian date (`YYYY-MM-DD`). Required defaults true. No coercion of
  arbitrary strings; false and zero remain values. Optional blank values omit.
- Select types share 1–50 unique nonempty single-line options, up to 160
  characters each. Multi-select values are arrays of unique configured strings,
  at most 50; required means at least one. Optional empty arrays omit. API order
  is retained; the UI sends configured option order. Switching select types
  retains configured choices.
- Text values are at most 10,000 characters, with valid Unicode and no NUL.
  Reject unknown fields, objects, nested values, files and oversized responses.
  Normalized values fit 64 KiB and the existing engine envelope. Errors identify
  fields without echoing submitted data.
- Output is `{ values, submittedBy, submittedAt }`, with server timestamp and
  member UUID or null for public Form starts. Input-request output always names
  its responding member. Audit/receipt/notice metadata never duplicates values.

### Form starts and public links

- `core.form@1` is one enabled root entry in a published graph. Discovery and
  admission recheck current active workflow, publication and grant under locks.
  Archived, paused, unpublished or disabled-entry workflows refuse new starts.
- Member access is current active workspace membership, including viewers; it
  grants no extra run/history/edit/credential permission. Settings need edit
  access. Ordinary Manual/API start refuses Form versions with a clear action.
  Form replay requires original exact version/input and retained submission.
- Submission binds displayed version, exact values, actor and stable command key.
  Changed publication returns a stale-form conflict while preserving fields.
  Current authority/grant checks still apply to exact retries. Admission, input,
  starter, receipt and normal outbox commit once under ordinary queue limits.
- Default access is members. Public enablement creates a 256-bit capability;
  store only its hash with public identity/revision/entry binding. Disable,
  regenerate or remove/replace the published entry revokes it. Lost plaintext
  links must be regenerated, never retrieved from storage.
- Public URLs use `/forms/:publicId#<capability>` and a dedicated redacted API
  header. Public endpoints have no session fallback, no-store/no-referrer and
  nondisclosing failures. Bounded discovery resolves only workspace/workflow
  identity; scoped reads/writes recheck the locked grant.
- Existing Redis rate limits per minute: reads 60/IP and 300/form; submissions
  10/IP, 30/form and 60/workspace. Public writes fail closed if limiting is down.
  No CAPTCHA or new rate-limit service. An anonymous starter cannot be excluded
  from later member approvals; choose member access if independence needs that.
- A plain configurable thank-you message is at most 1,000 characters; default
  **Thanks for your response.** It confirms acceptance, not run completion.
  Return it only after acceptance from that exact immutable version. Old-version
  retries retain its message after republishing. Public receipts omit run IDs.
  Legacy absent setup stays absent for strict portable equality; no new receipt.

### Requested input

- `core.request_input@1` shares fields, audience and expiry with F10; its starter
  may respond. Capture schema and up to 20 mapped scalar details/8 KiB once when
  opening. Capture mapped typed prefills within 64 KiB, total context 72 KiB.
  Captured context is immutable; the responder may edit the form before submitting.
- Current eligible members submit against the captured schema before expiry.
  One transaction locks authority/run/task, validates once, records one winner
  and wakes the normal continuation. Competing responses cannot overwrite it.
- Reuse F10's waiting, expiry/failure paths, cancellation, quiescent capacity,
  nested Call clocks and retention. Responses are authenticated, never public.
  F09 recovery excludes human tasks; replay creates a fresh request.
- Shared Weft labelled fields, checkbox groups and plain receipts support
  keyboard, phone and reduced motion. TanStack owns server state; local fields
  belong to the published version. Retained uncertain commands belong to the
  identity/link-scoped page and survive background schema/read changes.

## Slices and status

| Slice | Status |
| --- | --- |
| Shared field/model and Form/Request input definitions | Complete |
| Reuse task area; move-only shared UI ownership | Complete |
| Scoped grant/admission/response transactions and HTTP | Complete |
| Editor, member/public pages, Inbox and request response | Complete |
| Immutable details/prefills and exact command recovery | Complete (#305) |
| Versioned thank-you receipts and multi-select | Complete (#312) |

Model/forms owns validation; database/triggers/forms owns grants/admission;
database/runs/pending-tasks owns responses; API/forms and pending-tasks own HTTP;
web/features/forms and pending-tasks compose shared controls. Shared trigger
predicates remain in workflow-model/graph/triggers.ts.

Qualification covers grant/decision races, stale publications, access revocation,
exact-version receipts, malformed typed values, restart/expiry and immutable
multi-select prefills through real API/worker/browser and SQL. Full checks,
mocked e2e, React Doctor and green CI precede rebase merge. Start matching readers
before publishing new field/configuration shapes.

## Later work

Files, conditional/dynamic schemas, calculations, public mid-run input, CAPTCHA
and email links remain deferred. See the [forms guide](../guides/forms.md).

# F52 — File uploads in forms and input requests

Status: approved by the owner on 2026-10-26 (recommended options delegated).
Delivery: one of four features combined in `feat/spreadsheets-attachments-and-task-timeouts`.

## Outcome

A **Form** trigger, and the **Request input** step, can ask for files: an invoice
PDF, a photo or a spreadsheet. Each uploaded file reaches the run as a normal
Pertexo file reference, ready for **Read file**, **HTTP request** or an email
attachment (F49).

Benchmarks: n8n's Form "File" field and Zapier Interfaces' file upload. Make
relies on third-party form apps. Pertexo already has its own public forms, so
the field lives there.

## Current owners

- Field schema: `packages/workflow-model/src/triggers/forms/fields.ts`
  (`formFieldSchema` discriminated on `type`; `FORM_LIMITS`), with values in
  `values.ts`. Request input uses the same field model (check, and keep one
  model).
- API: `apps/api/src/forms/public.controller.ts` (public `GET` and `POST submit`,
  rate-limited with `form_read` and friends), `members.controller.ts` and
  `service.ts`.
- Files: the artifact upload flow (begin → direct upload → finalize) in
  `apps/api/src/artifacts/` and `packages/database/src/artifacts/uploads/`, with
  idempotency, quota and abandoned-upload cleanup. The styled drop zone from
  #529 lives in the web app's file input pattern.
- Web: the public and member form pages, the form setup editor and the Request
  input task page.
- Guide: `docs/guides/forms.md`, which says "no files".

## Decisions

- **New field type `file`**, with options: `accept`, one or more groups from
  *Documents* (pdf, docx, txt, md), *Images* (png, jpg, webp, gif, heic),
  *Spreadsheets* (xlsx, csv) and *Data* (json, xml); `maxFiles` from 1 to 5
  (default 1); and `maxBytes` per file up to 10 MB (default 5 MB). The value
  is a list of file references (always a list, even when `maxFiles` is 1, so
  mapping stays uniform), or omitted when optional and empty.
- **Upload through the form, not the general artifact API.** Add a form-scoped
  upload: `POST v1/forms/:publicId/uploads` (and the member and Request input
  equivalents) begins an upload bound to that form, field and published form
  version, and returns the same direct-upload capability the artifact flow
  uses. Finalize verifies size, checksum and type. Submitting then references
  those upload IDs. Reuse the existing artifact upload owners; don't write a
  second uploader.
- **Abuse limits.** Uploads count against the existing form rate limits, plus
  an upload-specific budget per form link and client (reuse the rate-limit
  admission, as `submit` does). A submission can only reference uploads begun
  through the same form link and session window. Unsubmitted uploads expire
  through the existing abandoned-upload cleanup (24 hours, or 1 hour through a
  public link). The workspace's storage quota applies, and over-quota uploads
  fail with the existing quota problem. Unsent public-link files also share a
  100 MiB allowance per workspace (`form.upload_limit`), so strangers can't
  fill the quota before cleanup.
- **Type checks** use extension plus a magic-number sniff for the allowed groups.
  A mismatch is rejected as `form.file_type_not_allowed`. Files are not
  virus-scanned; the guide says so, as the files guide already does.
- **Run input:** the trigger output contains the file references with name,
  size and type. Retention follows the run like other referenced files.
- **Privacy:** public responders never see other responses' files, and download
  links stay member-only as today.
- **Request input:** the same field type works in a run's input request, with
  the task page as the upload surface.

## Editor and design

- **Form setup:** the field type list gains **File**, with a paperclip glyph.
  Its options are tactile: the accept groups as toggleable pill chips with their
  glyphs, a small stepper for "Up to 3 files", and a size slider with tick
  marks at 1, 5 and 10 MB.
- **Responder page (public and member):** the field renders as the app's
  drop zone, adapted for forms: dashed outline, the accept groups spelled out
  ("PDF, images · up to 5 MB"), and drag-over that warms the border. Each
  file becomes a row with a type glyph, name, size and a circular progress
  ring that settles into a check when finalized, and a remove button. Errors
  appear inline on the row in plain words ("This file is 12 MB; the limit is
  5 MB"). Submit stays disabled until uploads finish, with the reason shown.
- **Phones:** the drop zone becomes a large tap target that opens the file or
  camera picker, rows stack cleanly, and touch targets are at least 44 px.
- **Run detail and Inbox:** uploaded files show as the same chips, and members
  can download them.
- Keep the Weft language and the forms' existing calm, receipt-like style. No
  layout shift as files are added or progress updates. Check 360 to 1920 px,
  light and dark, and keyboard plus screen-reader labels.

## Tests

- Model: field schema options, value shape and limits.
- API integration: begin/upload/finalize through the form, limits (size, count,
  type sniff, quota, rate limit), binding to form and version, a foreign or
  expired upload rejected at submit, cleanup of abandoned uploads, and
  idempotent submit.
- Database: upload ownership and expiry, reusing the artifact repository tests.
- Web: field setup, drop zone, progress, errors, phone layout and accessibility.
- Live journey: a public form with a file field. Upload a CSV, submit, and the
  run's **Read file** reads it. A too-large file is rejected inline. Repeat on a
  member form, and once through Request input.

## Out of scope

Virus scanning, image editing or resizing, files over 10 MB, file previews
beyond icons, camera-only capture modes, and public download links.

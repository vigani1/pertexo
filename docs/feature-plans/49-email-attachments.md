# F49 — Email attachments

Status: approved by the owner on 2026-10-26 (recommended options delegated).
Delivery: one of four features combined in `feat/spreadsheets-attachments-and-task-timeouts`.

## Outcome

**Send email** can attach files produced earlier in the run: a **Create file**
report, a form upload (F52), an HTTP response saved as a file, or a file passed
in as run input. "Email me the weekly report" works without a Code step.

Benchmarks: n8n Send Email (attachments from binary data), Zapier Email by Zapier
(attachment field), Make Email (attachments array). All three take files from
earlier steps, so Pertexo does the same with its existing file references.

## Current owners

- Step: `packages/integrations/src/email/` (`email.send_notification` v1; Resend via
  `client.ts`; schemas in `validation.ts`; plain-text body, one recipient).
- Files: finalized workspace file references (`kind: 'artifact'`) from
  `packages/node-sdk/src/artifacts/` and the worker's `NodeArtifactRuntime`.
  `packages/integrations/src/http-request/multipart/` already reads referenced
  file bytes for multipart parts, with failures in `FileInputFailure`. Reuse that
  path to read attachments; don't add a second file reader.
- Guide: `docs/guides/notifications.md` (email) and `docs/guides/files.md`, which
  lists email attachments as later work.

## Decisions

- **Input, not config.** Add optional `attachments` to the step input: a list of
  `{ file, filename? }`. `file` is a finalized file reference mapped from an
  earlier step or run input; `filename` overrides the stored name. Old steps
  without attachments behave exactly as before. Bump the step and executor
  versions only if the repository's versioning rules require it for a new
  optional input (check how earlier optional inputs were added, for example HTTP
  multipart, and do the same).
- **Limits** (in one exported constant, next to the existing email limits):
  at most 10 attachments, and at most 6 MB of files in total (8 MB after base64
  encoding), measured before sending. ADR 075 caps every outgoing file-backed
  request at 10 MiB and worker scratch at 20 MiB per attempt, so the email
  request has to fit inside that. Raising it later means amending ADR 075 and
  changing this one constant; Resend itself would accept 40 MB.
- **Filenames.** File references carry no stored name, so default to
  `attachment.<ext>` from the stored type (`attachment-2.<ext>` and so on when there are several). Strip path separators and
  control characters, cap at 255 UTF-8 bytes, and keep the extension. Two
  attachments may share a name; the provider handles that.
- **Content type** comes from the stored file metadata. Don't sniff or rewrite it.
- **Failures** use the existing file-input failures. A missing, unfinalized or
  other-workspace file fails the step with a clear problem before anything is
  sent. Too many or too large fails as `email.attachments_too_large` or
  `email.too_many_attachments`. Register the codes the same way as the
  existing email errors.
- **Retries and idempotency.** The step is `idempotent-with-key`. Attachments
  are part of the request fingerprint, so a retry sends the same files and a
  changed file is a different request.
- **Retention.** A referenced file stays retained while the run needs it, as
  for multipart parts. Sending doesn't copy or extend storage.
- **Secrets and logs.** Never log attachment bytes. The run detail shows the
  file names, sizes and count, not contents.

## Editor and design

The email step's inspector gets an **Attachments** section under the message:

- Each attachment is a compact file chip (file-type glyph, name, size). It's
  mapped from the same input-source picker other inputs use, so files from
  earlier steps appear as choices. An optional rename sits behind a small edit
  affordance.
- A slim **size meter** under the list fills toward the 6 MB total, shifting
  colour as it approaches the limit, with "3 files · 4.2 MB of 6 MB" in the
  app's monospace detail style. It's a calm progress line, not a warning box.
- An empty state invites "Attach a file from an earlier step", with the step
  glyph. No boxes inside boxes. Keep the Weft visual language (tokens, type,
  motion) and the app's existing chip and drop-zone patterns, so it reads as
  part of the same product.
- In run detail, the email step's output shows the sent attachments as the
  same chips, read-only.
- No layout shift as chips are added or removed. Check it at 360, 390, 768,
  1024, 1440 and 1920 px wide, in light and dark.

## Tests

- Unit: schema limits, filename sanitizing, size accounting (base64), fingerprint
  includes attachments, and missing or foreign files fail before sending.
- Integration: the executor reads real stored files through the artifact runtime,
  and the Resend request body carries the attachments (a test double for Resend,
  as the existing email tests do).
- Web: inspector mapping, chips, meter and limit messages, with behavior tests
  in the existing editor test style.
- Live journey: create a CSV with **Create file**, attach it in **Send email**
  through the local test mail path the existing journeys use, and assert the
  delivered message carries the file.

## Out of scope

HTML email bodies, multiple recipients, inline images, and attachments from
URLs not already stored as files. These are separate decisions.

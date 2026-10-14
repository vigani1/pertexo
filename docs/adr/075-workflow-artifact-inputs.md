# ADR 075 — Workflow artifact inputs

- **Status:** accepted
- **Date:** 2026-10-14
- **Plan:** [F04](../feature-plans/04-artifact-inputs-and-files.md)

Pertexo stores files and emits HTTP response artifacts, but cannot consume them
in workflow steps. The first consumer is HTTP Request: accept its
existing artifact descriptor as an alternative body, resolve it through a
workspace-bound worker read capability and verify all bytes before sending.
Keep the 1 MiB request ceiling and inline behavior. Follow ADR 069's current
pre-launch registration without HTTP v2, release cohorts, a new stored-value
format or streaming transport.

Files are opaque shared workspace data. Pertexo does not parse, decompress,
render, execute or virus-check them. Downloads remain attachments; users
explicitly send bytes through the existing unsafe HTTP action. MIME labels are
metadata, not evidence of safety. Filename and signed URLs are transient browser
data, never durable workflow fields.

Unreferenced finalized uploads keep their existing 30-day deadline. Retained
drafts, published graphs, input-case payloads and execution facts protect their
files until those owners release them. This deliberately keeps charging storage
for reusable workflow files instead of silently breaking them after 30 days.
Existing tables and row locks serialize reference acceptance against deletion;
no generic ownership table or second asset catalog. Preview outputs retain their
preview lifetime and cannot be promoted by copying an ID.

The trade-offs are a small first-file ceiling, no malware-scanning guarantee and
potentially long retention for referenced files. Larger streaming bodies,
multipart, parsers, asset discovery and artifact-aware recovery require later
evidence and scoped plans, not speculative machinery in this first release.

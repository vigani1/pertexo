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

## Proposed amendment — 2026-10-15: Read file and multipart

**Amendment status: proposed, awaiting owner review.** The accepted first-release
decision above is unchanged until this amendment is approved. The linked F04
follow-up is the detailed contract/placement/qualification plan. No runtime work
is authorized by this planning PR.

Allow explicit **Read file** (`core.read_file@1`) to turn a finalized file into
bounded JSON. The step uses the same workspace-bound, full-fingerprint verified
worker read and 1 MiB file ceiling. UTF-8/BOM JSON yields its parsed value; CSV
yields an ordered array of header-keyed records using a selected comma,
semicolon or tab delimiter and RFC 4180 quoting. Do not infer format from MIME
or filename, decompress, execute or parse files automatically on upload/download.

CSV defaults to string values, strict headers/column counts and no trimming.
Opt-in conversion recognizes only exact lowercase booleans and JSON decimal
numbers representable as finite JavaScript numbers with safe integral values;
otherwise retain the string. Leading-zero identifiers, out-of-range numbers,
null/date/currency-like text and whitespace are not silently converted. Quoting
changes CSV syntax, not conversion semantics. Reuse the 4,998-item cap and SDK
1 MiB/depth-64/10,000-member value bounds; wide data can reach those bounds sooner.
Use a pinned strict parser rather than maintain another CSV grammar.

Read file is safe to repeat: it reads immutable, checked workspace bytes and
changes nothing outside Pertexo. Invalid content is a definite failure, not an
unknown effect. Expose allowlisted parser reasons and numeric locations through
the existing executor-failure/attempt-summary path; never expose raw exceptions
or file content. Reuse the existing error-summary column and authorized detail
reads; no diagnostic service or new failure stored-value format.

To make recovery useful for this safe target, propose a **narrow exception to
ADR 072's artifact-descriptor refusal**: only when the failed recovery target is
Read file, admit complete descriptors inside otherwise bounded inline original
input/completed-prefix snapshots. Preserve all other F09 eligibility rules,
exact version/input, provenance, capacity, aggregate bounds and acknowledgements.
Acceptance locks and verifies all referenced artifacts in stable order in the
same transaction as copying owners and accepting the new run; preview is
advisory. Copies keep files alive under existing retention even if source details
expire. Foreign/deleted/corrupt metadata and expired preview references refuse.
Artifact-backed whole stored-value hydration and general file-aware downstream
recovery remain excluded. Do not broaden HTTP automatic retry or unknown-outcome
semantics. This scoped exception must be reviewed with the plan, not inferred
from the safe classification alone.

Allow **multipart HTTP Request** under the current `http.request@1` identity.
Part metadata/order live in optional HTTP configuration; each stable part key
uses an ordinary top-level input mapping for text or an existing file descriptor.
This keeps one mapping language and one multipart representation. Preserve part
order/duplicate names. Require bounded metadata, checked file reads and generated
boundary/Content-Type; reject conflicting outer Content-Type and GET/HEAD bodies.
Keep the 1 MiB **whole encoded body** ceiling, including part headers/framing,
and existing secure transport, connection fences and unsafe HTTP recovery rules.

An explicit multipart filename is durable **part metadata**, an exception to the
first release's filename rule. It is not added to the artifact descriptor and
must not be copied automatically from the user's local filename. Signed URLs,
boundaries, file bytes and browser File objects remain transient. Use a patched,
pinned encoder solely to construct bounded bytes; it never sends a request.

Files outside explicit Read file remain opaque. There is still no malware scan
or MIME safety guarantee, and downloads remain attachments. Existing ownership,
30-day unreferenced expiry, preview lifetime, storage charging and workspace
purge rules remain. No new role, service, storage, table, graph/checkpoint format,
HTTP generation or CI job is needed. Email attachments, webhook file ingestion,
Excel/other formats, larger streaming bodies and a file browser stay deferred.

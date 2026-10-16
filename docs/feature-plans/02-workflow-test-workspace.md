# F02 — Run-input cases and pinned samples

Status: slices 1 and 2 implemented. Slice 3 stays later.
Updated: 2026-10-16. [Roadmap](../product-roadmap.md).
Decisions: [ADR 061](../adr/061-workflow-input-cases-and-checked-manual-start.md)
and [ADR 080](../adr/080-draft-step-samples.md). History stays in git.

## Current code and ownership

Run-input cases and checked real starts are delivered (#145). The editor tests
one saved draft step through `api/node-testing`, durable database previews and
worker execution. Its Run command starts a published version. Keep these
separate; no new test engine or published-run override.

Shared workflow-model owns sample identity; the existing stored-value boundary
owns run-data JSON bounds. Database/authoring/step-samples owns persistence and
source reads; database/previews owns atomic
substitution and history. Node-testing owns HTTP. The web workflow-publish Test
panel owns sample management; workflow-editor displays its state on steps.
Existing retention, workspace purge, contracts and boundary checks are extended.

## Slice 2 decisions

The owner authorized pins on 2026-10-16. Recommended details below resolve the
old plan's open choices against current code; ADR 069 supersedes its old legal-
hold, release-cohort and production-enablement machinery.

- One shared pinned sample per draft step, created from pasted JSON or a
  successful authorized preview/run step in this same workflow. A specific node
  run identifies a loop iteration. Save copies data; deleting/expiring its source
  never changes the sample. Store provenance IDs, not provider messages.
- Pins live outside the graph. Publishing, Run published version, replay,
  recovery, child Calls, export, import and duplication never read/copy them.
  Existing isolated editor Test runs and previews use them automatically.
- Pin only ordinary inline JSON under the existing stored run-value bounds:
  256 KiB for its JSON value, depth 64 and 10,000 members. Reject
  non-JSON, malformed storage text, file/artifact-backed outputs and nested file
  references clearly. Read file can first turn a file into bounded JSON. Binary
  sample retention is later work; never save a dangling file reference.
- Identity includes definition key/version, config version/config, input
  mappings, connection references and enabled state. Labels, position and links
  do not invalidate an intentionally fixed output. One shared canonical identity
  function serves API/database/web; no second list of node types or hash helper.
- Changed setup marks a pin stale immediately in the editor. A stale or expired
  pin cannot execute a test or silently fall through to a provider call. Confirm
  an unexpired stale pin for the current saved setup, replace it, or remove it
  explicitly to test the real step. Expired data must be supplied afresh.
- A matching pin returns its saved output without validating unused provider
  settings/mappings, resolving credentials, creating an execution attempt or
  dispatching work. Its durable preview succeeds with `pinned` provenance,
  no start time and no invented execution duration. Preview history and the
  editor clearly say **Pinned**; setup/publication validation stays real.
- New test commands freeze the expected sample ID (or explicit absence) with
  input, draft revision and idempotency key. Under one admission transaction,
  current authority, locked draft/setup and expected pin must still match.
  Removal/expiry/change during admission refuses instead of dispatching.
  Accepted-receipt recovery precedes mutable pin/source checks, returning the
  original output after response loss. Legacy omitted fields retain hash bytes.
- Reads require workflow-read and run-read authority; management requires current
  workflow-update authority too. Owners/admins/builders manage; naming/creator
  attribution grants no special access. Active workspace/user/member checks and
  same-workspace source checks are repeated under the shared authority locks.
  Archived workflows are inspect-only. No public or API-token testing authority.
- Samples expire 30 days after explicit save/confirmation, matching retained run
  data; remove/replacement erases that sample payload immediately. The preview
  copy has the existing seven-day preview lifetime. No source-row foreign key
  extends source visibility or retention. No payload in logs, audit, receipts,
  notices or exports; warn that samples are shared run data, not secret storage.
- One table stores the current sample with the existing inline value format.
  A fresh opaque ID on replacement/confirmation is its compare-and-set token.
  No payload revision archive, legal hold, new format number or second store.
  Retain exact command receipts through the existing 24-hour window. Metadata
  and quota mutations serialize with authoring authority and the saved draft.
- Bound storage to 200 pins/workflow (the graph node cap), 1,000/workspace and
  16 MiB of actual retained signature/value bytes per workspace. Expired rows
  still count until erased. Replacement charges the net bytes atomically; a
  deleted payload releases its charge. These are bounded authoring quotas,
  following input cases, not a billing meter or new subsystem.
- Existing maintenance retention removes expired rows in bounded pages. Draft
  replacement removes pins for deleted steps; workspace purge removes pins before
  workflows. Current pins survive cosmetic draft edits; restoring a version
  retains only samples whose step still exists, with normal stale checks.

## HTTP and frontend

- Metadata list under `/workflows/:workflowId/draft/samples`; one step's payload
  and commands under `/draft/nodes/:nodeId/sample`. GET is private/no-store.
  PUT accepts pasted/source output or explicit confirmation with saved draft
  revision, expected sample ID and Idempotency-Key. DELETE has the same locked
  expected-ID/draft precondition. Strict contracts and ordinary CSRF/rate limits.
- The canvas and Test panel share one scoped metadata query. Fetch a sample's
  value when its dialog opens; selecting a step does not fetch its output.
- Use feature-local API/query/mutation owners and existing retained-command
  behavior. Freeze uncertain commands; preserve pasted JSON on conflicts and
  provide exact retry. Scope changes/authority loss clear forbidden data and
  fence late results. Refetch after a definitive change rather than overwriting
  another editor's sample.
- The Test panel offers Pin output, paste JSON, confirm stale and remove. Its
  Runs tab offers Pin output on retained successful step executions. Reuse
  JSON input/tree, Dialog, Status and buttons. Step badges distinguish pinned,
  stale and expired; show the original source and expiration. Pinned tests
  explain that the step is not called and need no provider-effect promise.
  Unpinned tests retain explicit real-effect acknowledgement.
- Phone, keyboard and reduced-motion behavior follow existing Weft components.
  No new design system, global sample store, graph editor mirror or binary viewer.

## Slices and status

| Slice | Status |
| --- | --- |
| 1. Named run-input cases and checked published starts | Delivered (#145) |
| 2. Bound draft samples, atomic preview substitution and editor/history | Implemented |
| 3. Suites, assertions and batch regression | Later |

## Required evidence

- Shared identity ignores cosmetic changes and invalidates every behavior field;
  exact size/depth/member/storage-text bounds, provenance and no-file errors.
- Real PostgreSQL authority/RLS, source read isolation, CAS/idempotency, quotas,
  source expiry, pin expiry, cleanup/purge and populated migration upgrade.
  Race pin replacement/removal and draft edits against admission; prove no
  execution attempt/outbox/provider call for pinned or refused stale commands.
- Exact retry after pin removal/source expiry returns its accepted pinned output;
  changed intent conflicts. Legacy preview commands and unpinned runs still work.
- Real browser/API/worker: pin a test output and pasted value, reload, consume
  it in a following test, change setup/confirm/remove, and start a real published
  run whose original step executes. Inspect durable pinned history and source
  facts. Test access loss/uncertain commands plus desktop/phone layouts.
- Full lint/types/build/unit/contract/schema/boundary checks, mocked e2e and React
  Doctor; green PR CI before rebase merge. Matching readers/writers deploy
  together; existing exact migration-head readiness refuses mixed writers.

## Later work

Suites/assertions, batch tests, binary/file-backed pinned samples and a full-draft
workflow test command. Keep the current single-step preview seam; never label a
published real run as an isolated test. No automatic production-data capture or
automatic redaction claim.

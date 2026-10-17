# F14 — Workspace data tables

Status: first slice delivered in #334; editable columns delivered in #337; streamed exports delivered in #338; explicit workflow alias review delivered in #339. Parent:
[roadmap](../product-roadmap.md). Decision: [ADR 083](../adr/083-workspace-data-tables.md).

## Outcome and current foundations

Small typed workspace datasets, managed by editors and usable from workflows.
Current main has workspace authority/forced RLS, bounded JSON, ordinary worker
capabilities, idempotent commands, CSV parsing, draft tests and capacity usage.
The first table slice is delivered. Internal platform tables remain inaccessible.
No service, role, queue, package or CI job is added.

## Decisions and bounds

- Typed schema at creation (evolution rules below): 1–20 named columns, text, finite number,
  boolean, ISO date (YYYY-MM-DD) or JSON. Each column can be required; missing
  optional cells are null. No implicit conversion in API/node writes. CSV uses
  column-directed conversion and reports the row/column on failure. JSON columns
  contain JSON, not expressions. User names are identifiers, never SQL names.
- A table optionally selects one required text/number/date column as its unique
  key. Uniqueness is workspace/table scoped and uses canonical typed equality.
  Upsert requires that key; key updates obey the same uniqueness constraint.
  Canonical unique key text must fit 1 KiB for a bounded PostgreSQL index.
- Defaults: 20 tables, 20 columns, 10,000 rows/table, 50 MiB stored cell JSON per
  workspace. Owners/admins can raise these to 100 tables, 50 columns, 100,000
  rows/table and 1 GiB. A row is at most 64 KiB. Counts/bytes are checked under
  one workspace quota lock, including concurrent imports and workflow writes.
  Lowering below current use is refused. This is bounded storage, not arbitrary
  SQL or a general indexing product.
- Find supports up to 10 AND predicates (equals, not equals, contains, greater /
  less than), an optional typed sort and stable row-ID tie break. Reads are
  paged, at most 100 UI rows or 1,000 workflow rows; output must fit the existing
  execution envelope. Narrow the filter/limit when a result is too large.
- Insert returns a row. Update and Delete require a filter or an explicit row
  ID; all matching rows are affected atomically, with at most 1,000 per command.
  Upsert by key returns the inserted/updated row. Writes use typed values and
  compare table/row revisions for interactive edits to prevent lost updates.
- Workflow mutation plus a durable operation receipt is one PostgreSQL
  transaction, fenced to the current worker attempt. The stable run/node
  invocation identity survives retry; the same command returns its original
  result even after later row edits/deletion. A different command under the
  same identity is refused. Receipts retain only bounded results, live until
  their run/preview is purged, and are removed before it. A deliberate replay
  is a new run and can perform a new write.
- Find is safe; writes are idempotent with a key and count as effects in both
  single-step and whole-draft tests/suites. The legacy mayCauseExternalSideEffect
  disclosure includes table effects while mayContactProvider stays false; remove
  the old implication constraint rather than falsely claiming network access.
  Existing consent applies. Pins skip
  the operation. Worker reads/writes are restricted to the run's workspace;
  API callers cannot supply runtime scope or SQL.
- All active members can read/export. Owners/admins/builders manage tables and
  rows; only owners/admins change quotas. Suspended/deleting workspaces are
  read-only. No new role or automation-token capability in this slice.
- Table names are unique and stable; step configs store the name so workflow
  export/import contains references only, never table data. Deleting a table
  requires explicit confirmation and makes references fail clearly; recreating
  the name is an explicit retargeting choice. The UI explains this. Schema
  changes follow the bounded evolution rules below. Cross-workspace lookup and
  user-defined indexes stay later.
- CSV import uses the existing pinned csv-parse dependency, RFC 4180/UTF-8/BOM,
  headers matching columns, a 1 MiB request bound and at most 1,000 rows per
  atomic import. Complete export streams the whole filtered result within table quotas,
  with safe quoting and spreadsheet formula escaping; the workflow result envelope stays unchanged. No file browser or artifact-storage coupling.

## Ownership

| Owner | Responsibility |
| --- | --- |
| node-sdk/data-tables | Browser-safe typed execution contract, schema/value/filter rules and limits |
| nodes-core/data/tables | Five catalog steps and executors using the scoped capability |
| database/data-tables | Workspace tables/rows/quotas, typed queries and atomic receipts |
| schema/data-tables | Shared physical tables, constraints and workspace fences |
| worker/attempts | Lease-scoped runtime capability for real, preview and draft-test attempts |
| api/data-tables | Session routes, guards, once-only input validation and errors |
| contracts | Request/response/OpenAPI contracts |
| web/features/data-tables | Weft list/table page, typed row forms, import/export and quota controls |
| editor | Table setup via normal config/mapping controls; no copied table state |

## Delivery and acceptance

One usable PR: contracts and additive migration; scoped persistence and receipt
fencing; five nodes/worker wiring; API; table page and node setup; guides.
Moves, if needed, are separate commits. Each commit gates on lint/types/tests.

Qualification: typed values and malformed CSV; filters/sort/paging; concurrent
quota/key/upsert races; retry after committed write/changed rows; stale leases,
preview effects, workspace isolation/member loss/deletion; populated upgrade and
purge; real worker workflow plus browser create/edit/import/export at desktop and
phone widths. Run normal repository checks, mocked e2e, React Doctor and green
exact-head CI. Record measured bounds and any limitations below.

## Later work

Type changes, table renaming, composite keys/indexes, larger imports,
row history, external database connectors, formulas and billing.

## Tracker

- [x] Current code reconciled and decisions recorded before implementation.
- [x] Persistence, lifecycle and retry invariants qualified.
- [x] Nodes, API and frontend qualified together.
- [x] Guides, bounds and real evidence recorded.
- [x] PR #334 merged with green exact-head CI.

## Qualification evidence (2026-10-17)

- Real PostgreSQL: concurrent upserts/unique keys, stale row and table revisions,
  atomic imports, row-quota races, member authorization, workspace isolation and
  workspace purge passed. Imports use one bounded bulk insert and shared quota
  accounting rather than one transaction/query round trip per row.
- Real worker: all five operations completed in order. A lost insert
  acknowledgement caused two attempts and only one insert/receipt. Transient
  storage failures use the existing retryable network class; unknown internal
  errors retain normal failure handling.
- Real browser/API/worker: create table, required/typed columns and key, lost
  acknowledgement retry, rejected malformed CSV, successful import, row edit,
  CSV export and Find rows publication/execution passed. Table pages checked at
  1280 and 375 pixels with reduced motion and no document overflow.
- Ordinary workers always acquire database-backed capabilities; provider/file
  services remain optional. This prevents table-only installations from losing
  their scoped read/write capability.
- Retention, fence, populated-upgrade and maximum-size proofs passed. Root
  format, typecheck, lint, unit, contract, architecture, schema ownership and
  dependency checks passed. React Doctor: 100/100, no new diagnostics.
  Full mocked browser suite: 206 passed. All required exact-head CI passed; #334 merged.

- Maximum-row qualification: imported 100,000 real rows in 100 atomic batches
  through the serving-role store in 1,726 ms; filtered/sorted read at that maximum
  took 59 ms. Exact stored bytes: 4,689,000; returned 100 matches / 11,641 bytes.
  Row 100,001 was refused and counters remained exact. These local timings are
  measurements, not CI timing assertions or a production throughput promise.
- Preview capability proofs: unmarked/stale attempts refused; changed retry
  command refused; exact original result returned after row edits and table
  deletion. Real preview retention removed the receipt while leaving table rows.

- Real browser test-safety proof: refusal without effects consent, acknowledged
  whole-draft write, acknowledged single-step preview with provider contact false,
  then a pinned draft test completing without another write. This caught and
  fixed provider-key derivation using the original effect class after a test
  substitution; the engine now derives the key from the effective admission
  class. A focused regression fails before the fix and covers ordinary writes.

## Editable columns and complete CSV export (2026-10-17)

Owner-approved follow-up; first reconcile the existing fixed-schema implementation.
No new service, role, package or CI job. Amend ADR 083 rather than create an ADR.

### Decisions

- Columns have an immutable ID and a mutable, unique display/name identifier.
  Backfill existing IDs from their original names, preserving existing workflows
  and stored rows without rewriting published versions. Initial schema IDs are
  the creation names within that table; later additions receive fresh opaque IDs; deleting and recreating a name never revives an old binding.
- Workflow table config freezes alias-to-column-ID bindings. Inputs and outputs
  keep the aliases chosen when configured, including JSON paths, while the
  scoped runtime resolves IDs to current column names. The editor displays human
  names and provides explicit column review; background refresh never rewrites
  the draft or mappings. Removing a bound column is a clear publish/start error.
- Legacy steps without an explicit binding use the original-name IDs. After a
  column removal, unverifiable legacy steps must review/rebind before starting;
  refuse conservatively rather than guess from arbitrary mapping expressions.
  No mutation of immutable published graphs. New/imported cross-workspace steps
  must explicitly reselect their target columns when IDs do not match; never
  silently bind a recreated or unrelated column just because its name matches.
- Add optional columns with null existing cells, or required columns with a
  typed non-null default for every existing row. A supplied default is also
  checked against row and workspace byte limits. It is a backfill, not a hidden
  default for future workflow writes. Renames keep IDs and stable workflow
  aliases. Confirm deletion and explain loss of stored cells / any unique key.
  Keep at least one column. Type changes remain deferred in this follow-up.
- Change or clear the single unique key only when the selected column is a
  required text/number/date column and all existing values fit the current key
  bound and are unique. Clear old key values inside the transaction before
  assigning replacements; constraint failure rolls the complete change back.
- Every schema edit compares the current table revision, serializes through the
  existing workspace quota and table locks, rewrites rows in bounded batches,
  maintains exact stored-byte/row counters and revisions, and records one safe
  audit event in the same transaction. No row values/defaults in audit metadata.
  Retried commands return their original result and do not repeat the audit.
  CSV conversion stays API-owned but runs after claiming the exact raw-CSV
  command, under the table lock. This prevents schema changes between header
  validation and import, and lets a committed import replay after a rename.
  Pre-upgrade import receipts with the previous parsed-row hash refuse safely
  rather than repeat an unverifiable command; inspect history before a new import.
- Check bindings in publication/validation and common run admission, including
  nested loop bodies and Call children. Replays/recovery keep their immutable
  graph's bindings. Pinned test substitutions require no table operation.
  Runtime rechecks under its existing write/read transaction for schema changes
  after acceptance; completed write receipts retain their exact original result.
- Complete CSV export follows the streaming rules below, superseding the earlier
  1 MiB complete-export limit. Workflow Find output and CSV import limits stay unchanged.

### Ownership and evidence

- node-sdk/data-tables owns column/binding/value contracts and pure binding rules;
  nodes-core consumes the configured binding through its existing scoped runtime.
- database/data-tables owns schema transactions, reference checks and snapshot
  export. Existing authoring/runs owners call the same reference validator.
- API owns once-only request validation; contracts/OpenAPI expose schema edits
  and full export. Web data-tables owns plain schema forms and export feedback;
  editor owns explicit table-column bindings and normal mapping controls.
- Prove populated upgrades, rename preserving published mappings/output aliases,
  deletion refusal at publish/start, ID non-reuse, quota/required/default failures,
  uniqueness/concurrency/rollback/idempotency/audit and ordinary workspace fences.
  Prove CSV beyond page one, whole filtered/sorted results, formula protection,
  UTF-8/escaping bounds and consistent schema/data while writers run.
- Real worker and owned browser journeys at desktop/phone widths, normal lint,
  types/unit/mocked e2e, React Doctor, schema/contracts/boundaries and green CI.

### Follow-up tracker

- [x] Reconcile code and record ID/binding/export decisions.
- [x] Atomic schema changes, upgrade and reference fences qualified.
- [x] Editor/forms and full CSV export qualified end to end.
- [x] Guide and ADR 083 updated. Merge remains gated on green exact-head CI.

- Follow-up local evidence: 22 database integration tests, a populated 0028 →
  0029 upgrade, and real worker execution passed. The 100,000-row rename kept
  exact counters (4,177,780 stored bytes); local duration ranged from about 3
  seconds to 40 seconds under concurrent verification load. These are measured
  observations, not CI timing assertions or throughput promises.
- The real browser journey passed at 1280px and 375px: import 123 rows, export
  beyond the 50-row page, add a required default, run the exact published version
  before/after rename with original aliases, and refuse deletion-bound drafts
  at publish and old versions at start. Existing effects/pins and variable
  snapshot journeys passed alongside it. Mocked regressions cover human aliases,
  whole filtered export and exact retry after a lost schema-edit acknowledgement.

## Streaming complete exports (2026-10-17)

Owner-requested follow-up, one PR before workflow alias adoption. No new service,
role, dependency, stored format or CI job.

### Decisions and ownership

- Export all rows or all matching rows up to the existing row/storage quotas;
  remove only the complete-export 1 MiB cap. Snapshot the schema and rows in one
  existing repeatable-read workspace transaction. Fetch at most 16 rows by
  `(workspace_id, table_id, id > last_id)` keyset and await downstream backpressure.
  CSV encoding yields one row at a time with the existing quoting/formula rules.
- Exports explicitly use creation/row-ID order, including filtered exports.
  Keep on-screen Find sorting. Explain export order in the UI/guide; reject a
  sort parameter rather than silently ignore it. Unindexed arbitrary-column
  sorting per keyset batch would repeatedly scan/sort a quota-sized table.
- The database owns the snapshot, keyset and encoder. Its export method lends an
  async CSV iterable to an awaited consumer inside the transaction; it never
  returns a live client or lets a consumer outlive the transaction.
- Prepare and validate the current-column query before lending the iterable to
  the HTTP consumer, so a stale filter remains an ordinary problem response.
  Once the stream is handed to Fastify, every failure aborts the socket, including
  failure before the first byte. `headersSent` is too late a fence: destroying a
  queued stream before headers can otherwise become a complete empty 200 CSV.
- API owns HTTP streaming, cancellation and finalization: a bounded PassThrough
  and `pipeline` feed Fastify's normal response stream. End the download only
  after the read transaction finishes successfully. Any later failure destroys
  the stream/response; never turn a partial export into a successful CSV. Errors
  before streaming keep ordinary problem responses. Verify abrupt upstream loss
  through the existing single-server proxy as well as direct HTTP.
- Native browser form POST downloads avoid Fetch/Blob/whole-file buffering in
  application memory and work in Chromium, Firefox and WebKit. Reuse the existing
  bounded raw URL-encoded body transport; decode the form once in the export
  boundary. Query JSON and the session CSRF token are form fields, never URL
  credentials. Keep JSON POST for direct API consumers. The existing shared
  CSRF guard/policy accepts the explicitly supplied transport token; all other
  routes continue using their header token. No multipart parser or service worker.
- A generic ApiClient download operation owns same-origin paths, CSRF and native
  form submission. Feature data code owns the endpoint/query. Download in a
  separate browsing context so a pre-header error never replaces the table page;
  the browser owns progress, cancellation and failure feedback. Do not announce
  successful completion from the initiating button.
- Add an existing-limiter endpoint class for exports: fail closed, 5 starts per
  actor and 10 per workspace per minute. Retain session/workspace fences and pool
  bounds. Export gets a 30-minute operation budget and aborts on disconnect;
  ordinary request budgets stay 30 seconds. This is a timeout, not a file cap.
- Amend ADR 083 and the guide. Remove the old buffered response contract and
  browser Blob download. No file moves are needed.

### Qualification / tracker

- [x] Reconcile current code and record streaming/transport choices.
- [x] Keyset snapshot, cancellation, slow consumers, formula escaping and export
  beyond 1 MiB; stream a quota-sized dataset while measuring peak memory.
- [x] Real HTTP and native browser downloads: valid CSV, filtered full result,
  auth/CSRF/rate refusal and interrupted transfer marked failed; desktop/phone.
- [x] Root checks, unit/mocked e2e, existing live journeys, docs and green CI; #338 merged.

Local measured export evidence: 100,000 rows / 1,068,188,909 CSV bytes streamed
under a 192 MiB Node heap limit. Peak sampled JavaScript heap was 57,796,280
bytes; export took 23,915 ms under concurrent local verification load. This is
an observation, not a CI timing assertion or throughput promise. Direct HTTP
and nginx/Caddy proofs reject interrupted reads, including failure after the
last row but before transaction completion. Native form downloads work with
Chromium, Firefox and WebKit against real HTTP; WebKit's Playwright-intercepted
attachment does not emit a download, so that mock is not browser qualification.

The owned real API/worker/browser journeys passed at 1280px and 375px, including
a >1 MiB native download, formula escaping and invalid-CSRF refusal. Existing
schema-edit, publication, effects/pins and variable-snapshot journeys passed.
React Doctor reported no new diagnostics (baseline score 92/100).


## Explicit workflow column-name adoption (2026-10-17)

Reconciled after #338. Runtime bindings already preserve aliases across table
renames. This follow-up belongs in the editor, with no new stored format,
dependency, API, database migration, service, role or CI job.

### Decisions / ownership

- Show `amount (now called total)` wherever the table Setup lists a renamed
  workflow field. A table refresh never edits the draft. Removed IDs stay
  visibly removed and require the existing explicit column review first.
- Offer **Use the new name** (plural for multiple renames). One review adopts
  current names for all currently bound columns together, preserving their IDs
  and bound subset. This handles swapped/colliding old aliases without temporary
  aliases or silently retargeting columns. It does not add/remove columns.
- Before applying, list every old/new field name and affected later mappings,
  including nested bodies and the callable workflow result. Inspect ordinary
  paths with the shared JSON-path parser. Whole-output consumers are listed for
  review too. Reachable expressions, Code steps and embedded paths may compute
  their references dynamically: identify them as manual review rather than claim
  that a static scan proves them safe. Do not add a second expression parser.
- Explain that this step's values/filter/sort mappings and listed later mappings
  need review; adopting names does not rewrite input data, expressions, Code or
  other steps. A path may break or select a different column after a name swap.
  The user confirms the displayed change deliberately; published versions keep
  their original aliases. Normal pin and suite staleness follows the draft edit.
- Freeze the review against the draft and bound column IDs/names, and require
  reopening if either changes. The general table revision also advances on row
  writes, so it must not invalidate a name review. Apply through the existing node-form command as one undoable
  draft edit/save, keeping ETags and serialized saves. Read-only editors cannot
  apply. Use the existing dialog, plain controls and a stable focus destination.
- Editor-local pure helpers own the adoption/impact calculation; the inspector
  composes them with the existing table query and scoped draft store. Production
  files stay in place; the new component test lives in its data-tables area,
  relocated in a separate move-only commit. Update the guide and clarify ADR 083's explicit-alias rule.

### Qualification / tracker

- [x] Current code reconciled and decisions recorded before implementation.
- [x] Unit coverage: ID/subset preservation, swaps, removals, nested/direct/whole
  output references, dynamic review and stale review refusal.
- [x] Desktop/phone: rename visibility; no automatic save on refresh or cancel;
  explicit review, one draft change, persistence/undo, and read-only controls.
- [x] Real API/worker: old publication retains old alias; explicitly adopted new
  publication returns the new alias. Root/web checks, mocked e2e, React Doctor,
  guide complete; merge is gated on green exact-head CI.


Local qualification: all 1,252 web unit tests and 212 mocked browser tests
passed. Eight new focused regressions cover ID/name swaps, removed IDs,
nested/direct/whole-output consumers, dynamic review, stale draft/name changes,
ordinary row-write stability, Cancel, focus restoration and read-only controls.
Owned real API/worker/browser journeys passed at 1280px and 375px: V1 retains
`amount`; explicit adoption and a new V2 return `total` with the same IDs. Undo,
reload, no automatic alias save and later-path disclosure passed in the browser.
Root dependency/boundary checks and web build/lint/types passed. React Doctor
reports no new diagnostics (92/100 baseline). No production file moves or new
dependencies. The new component test was relocated into its data-tables area in a separate move-only commit.

## Stream initiation failure correction (2026-10-17)

An actual HTTP regression reproduced an empty
200 attachment when its producer threw before its first byte. The correction
aborts every failed stream after hand-off and moves current-schema query
validation before hand-off. The regression also distinguishes ordinary
pre-consumer problem responses. Existing mid-stream and transaction-end failure
checks remain, and nginx/Caddy also prove a before-header upstream loss is a
non-download error response. No new format, service, role or decision is introduced.

- [x] Reproduce the empty-200 failure with actual HTTP before fixing it.
- [x] Prepare current-schema filters before hand-off; qualify ordinary errors,
  zero-byte, partial and transaction-end failures through HTTP and proxies.
- [x] Requalify the 100,000-row export under a 192 MiB heap and local checks.
  The correction merges only after green exact-head CI.

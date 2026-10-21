# F04 — File inputs and artifact lifecycle

F45 amendment (2026-10-21): F45 extends upload/raw/multipart file transport to 10 MiB through verified private scratch, and adds explicit Read file pages / Create file from pages. Inline reads and values retain their existing limits; file-aware recovery stays deferred. See the [approved F45 plan](45-bigger-files-and-paged-data.md) for delivery and qualification; older limit descriptions below record the original slices.

Status: first release complete on 2026-10-15; Read file/multipart follow-up approved on 2026-10-15; implementation in progress.
The owner accepted the HTTP consumer, 1 MiB budget, opaque-file policy and reference
lifetime on 2026-10-14. Delivery and qualification evidence is recorded below.
Created: 2026-09-28. Reconciled against main
`9c095bd258306c2a0fd0b618ceb0a584850e3baf` on 2026-10-14.
Parent: [product roadmap](../product-roadmap.md).
Decision: [ADR 075](../adr/075-workflow-artifact-inputs.md).

## Outcome and scope

Upload a file beside an HTTP Request body mapping, finalize it, save and publish
the workflow, then send its exact bytes to the configured service. Alternatively,
upload into manual run input and map that reference into the HTTP body. An HTTP
response artifact can feed a later HTTP request through the same input.

The first release includes the consumer, both input-local upload entry points,
retention safety, documentation and real integrated qualification. CSV/JSON
parsing and multipart are approved in the follow-up below; generated files are delivered by [F34](34-create-file.md); asset discovery remains
later work. Undelivered controls stay absent.

## Reconciled foundation

- `apps/api/src/artifacts/service.ts` already authorizes begin, finalize,
  metadata and download. Begin requires an idempotency key; finalize is
  idempotent. PUT alone does not make an artifact available.
- `packages/database/src/artifacts/` owns metadata, reservations and accounting.
  Pending uploads have 15 minutes; available user uploads receive 30 days.
  Existing capabilities are `artifact:upload` and `artifact:read`.
- `packages/artifact-store/src/store.ts` exposes a read stream verified against
  stored length, metadata and SHA-256. It owns bytes, not workspace permission.
- `apps/worker/src/attempts/artifacts/runtime.ts` currently exposes write only.
  The SDK reference already contains ID, length, media type and SHA-256.
- HTTP Request accepts optional inline UTF-8/base64 bodies. Its executor and
  secure transport both enforce 1 MiB request bodies; GET/HEAD forbid bodies.
  Responses can already return an artifact descriptor.
- Web `features/artifacts/data/artifacts.api.ts` exposes metadata/download only.
- `packages/database/src/lifecycle/run-artifact-retention.ts` protects execution
  references and preview links, but not drafts, published graphs or input cases.
  `artifact_links` has a preview-only foreign key: do not generalize it.
- ADR 069 supersedes older dual-region, legal-hold and release-cohort machinery.
  This feature must not revive those systems.

## Accepted decisions (2026-10-14)

1. **Consumer:** add an artifact alternative to the current HTTP Request body
   input and one scoped worker read capability. Keep inline inputs unchanged.
   Follow ADR 069's single pre-launch registration; no HTTP v2 or graph rewrite.
   This replaces the original outline's separate-version recommendation.
2. **Budget:** consume at most 1 MiB (1,048,576 bytes), enforced against actual
   metadata and bytes. New browser upload controls enforce the same bound before
   reading a file. Existing generic upload/response limits stay unchanged.
   Verify the entire bounded file before provider dispatch, using the existing
   secure byte-body transport. No streaming transport, hash library or browser
   hashing worker is needed for this first bound.
3. **File policy:** opaque bytes with valid supplied MIME type, or
   `application/octet-stream` when absent. MIME labels do not prove safety.
   No parsing, decompression, rendering, execution or malware scanner. Downloads
   remain attachments; upload copy states that files are not virus-checked.
   Sending them to a service uses the existing unsafe HTTP effects warning.
4. **Ownership:** finalized uploads are shared workspace artifacts. Keep the
   existing 30-day unreferenced retention; retained drafts, published versions,
   input-case payloads and execution facts protect referenced files. Archiving
   does not release a reference. Last-reference removal allows normal cleanup
   after expiry, not immediate deletion. Storage remains charged until physical
   deletion; workspace purge remains authoritative.

No production rollout, paid provisioning, Docker image download or uncontrolled
external provider call is authorized. Use owned local storage and endpoints.
Return with measured evidence if a larger limit is necessary.

## Contract and worker behavior

Body accepts either the existing `{ encoding, value }` or existing output shape
`{ kind: 'artifact', artifactId, byteLength, mediaType, sha256 }`. Do not add
workspace IDs, filenames, URLs or storage keys. Absent body stays absent;
GET/HEAD reject either body variant.

Add a server-only SDK read operation taking the reference, byte ceiling and
signal, returning verified bytes. Bind workspace/attempt identity in the worker
factory; the executor cannot choose a workspace or arbitrary storage path.
Only consuming manifests receive the read capability. Existing writers remain.

Before storage access, load available metadata through forced workspace RLS and
match all descriptor fields. Reject pending/deleting/deleted/missing/foreign or
mismatched references. A forged small length cannot bypass the row's real size.
Expired-but-referenced available artifacts remain usable: lifecycle status is
the authority. Preview-owned output cannot acquire permanent authoring/real-run
ownership by copying its ID; keep and qualify the preview lifetime explicitly.

Consume the verifying stream completely before HTTP dispatch. Bound actual bytes,
check cancellation, release streams and zero owned buffers on every exit. Never
hold a database transaction during object-store I/O. Preserve connection checks
and dispatch evidence. Artifact media type supplies Content-Type only when no
permitted explicit header supplies it; keep credential collision rules.

Unavailable/corrupt/oversize input before dispatch is not an unknown HTTP outcome.
Integrity and missing-reference failures are definite; store availability uses
existing pre-dispatch operational retry rules. After dispatch, preserve existing
unsafe HTTP classification and F09 acknowledgements. Never automatically retry
an unknown outcome or broaden F09's supported reused prefix in this feature.

## Reference lifetime and races

Extend existing retention reachability to authoring graph JSON and saved input
payloads alongside run/attempt/event/checkpoint references. Account for every
retained input-case revision that is still loadable, not only the latest one.
Reuse existing tables/coordinator; no asset catalog or generic owner-kind index.

One TypeScript-owned collector recognizes supported bounded artifact descriptors,
including nested loop bodies and literal mappings. Persistence owners share it.
Do not treat incidental strings or every `artifactId` property as authorization;
keep existing conservative execution retention where necessary.

Reference writers lock artifact rows in stable ID order, verifying workspace,
available status and exact metadata in the transaction that persists the owner.
Reconcile the actual paths for draft save, publication, import, duplication,
restoration, input-case writes, manual/replay admission and durable node values.
Reuse equivalent existing checks rather than adding a second validation layer.

Cleanup locks the artifact and checks retained owners before marking it deleting.
Writer wins: cleanup sees the committed reference. Cleanup wins: attachment is
rejected. No late writer revives deletion. Prove both outcomes with independent
connections. Unsaved browser state is not a durable owner; an unattached upload
expires normally. Show that consequence beside the control.

If correct ordering needs a schema/SQL fence/ownership mechanism outside these
existing tables and row locks, stop for the owner rather than introduce it.

## Placement

| Owner | Change | Must not own |
| --- | --- | --- |
| `packages/node-sdk/src/execution/contract.ts` | Scoped server read interface, existing reference | SQL/browser upload |
| `apps/worker/src/attempts/artifacts/` | Read adapter, authority, cleanup, wiring | Graph policy/public API |
| `packages/artifact-store/src/` | Reuse verified stream | Tenant grants/accounting |
| `packages/integrations/src/http-request/` | Body union and exact-byte consumption | Direct SQL/S3 |
| `packages/node-catalog/src/` | Current registration and capability projection | Another executor/cohort |
| `packages/database/src/artifacts/` | Reference checks and row locking | Provider HTTP |
| Database `authoring/`, `runs/`, `lifecycle/` | Owner writes and retention reachability | Duplicate artifact rules |
| Web `features/artifacts/` | Upload adapters, local lifecycle, focused control | Editor commands/global file store |
| Web `features/workflow-editor/` | Body-source composition, one undoable edit | Signed URLs in graph |
| Web `features/workflow-publish/` (current run-dialog owner) | Manual-input upload composition | Stored browser File objects |

Keep roughly ten files per directory. Necessary moves get separate buildable
commits. Cross-feature consumers use the artifacts public interface; adapters
stay feature-local. No generic upload framework, new package or duplicate store.

## Browser behavior

HTTP body mapping keeps inline and mapped-data choices, adding Upload file.
Only finalized descriptors become one undoable draft edit. Replace/clear changes
the draft, not shared physical bytes. Preserve ETag/conflict/save/publish barriers.

Manual input remains editable JSON. Insert a finalized descriptor at an explicit
bounded property path, initially `file`, checking current JSON and the workflow
contract. Confirm overwrites; never coerce non-object input or invent a contract
file type. Existing mappings read that property. Replay retains its own explicit
input/version confirmation.

The artifacts feature owns selected, hashing, reserving, uploading, finalizing,
available, canceled and uncertain states. Hash before begin; retries retain exact
metadata/key. Signed PUT uses returned headers with browser-owned Content-Length
supplied by the browser. Never send the session cookie/application token to S3.
The feature-local transfer adapter uses Fetch with credentials omitted and no
redirects. Show real transfer phases, not simulated byte progress: Fetch provides
no portable upload-progress events, while XHR cannot omit same-origin cookies.
At this 1 MiB bound, an indeterminate live thread avoids a second transport or
restricting storage to another origin. PUT success leads to finalize, not attachment.

Cancellation aborts owned work but cannot undo committed finalization. On uncertain
finalize, read metadata or repeat finalize for the same identity. On uncertain PUT,
reconcile/finalize that identity before creating another reservation. On target,
person or workspace changes, abort and prevent late attachment. Reload needs no
persisted signed URLs/File objects; if reselection is needed, match length/type/
hash before retrying the original reservation. Expiry requires fresh admission.

Files, bytes, filenames and signed URLs stay out of Query/mutation caches, logs,
localStorage and graph JSON. Persist finalized descriptors only. Safe metadata
queries remain server snapshots. Use existing Weft Status/thread pieces, plain
labels, keyboard controls, announced progress, reduced motion and 375px layouts.
Show human byte units and retention consequences. Storage unavailability must be
explained as configuration, not falsely as a changed role.

## Delivery order

1. **Decision PR:** accepted scoped plan/ADR and roadmap. Approval precedes
   consequential runtime implementation; no placeholder UI.
2. **Consumer/lifecycle PR:** SDK/worker read, HTTP body, durable reference checks,
   cleanup protection and docs. Real script-driven upload/finalize/consume proof
   precedes enabled browser controls.
3. **Upload UI PR:** both input-local entry points and failure states, Weft/browser
   qualification and guide examples.

Each code PR passes lint, strict types, units, relevant integration, mocked browser
and real integrated gates. Run React Doctor after React edits; investigate new
findings without unrelated warning cleanup. Every commit stays buildable and gated;
no amend/rebase/skipped hooks. PRs include Moved/Removed/Lines. Rebase-merge only
with green CI; inspect natural main. Keep local, merged and production status separate.

## Acceptance evidence

- Real Chromium signed PUT/CORS/checksum/signature, finalize, attach, save/reload,
  publish and worker execution. Independently compare controlled endpoint bytes,
  length/hash and SQL facts. Also test response-artifact chaining and manual input.
- Empty/binary/invalid UTF-8 files, absent MIME type, exactly 1 MiB and one byte
  over. Measure worker/browser memory and read time, including crypto/transport
  copies; no zero-copy claim. Existing inline requests remain unchanged.
- Wrong metadata or stored digest, unavailable lifecycle, foreign workspace,
  viewer/revoked-member/CSRF denial and suspended/deleting workspace. Confirm
  rejected or corrupt files cause no provider dispatch.
- Signer/PUT failure, lost finalize reply, cancel during hash/transfer, expiry,
  navigation/scope change, replacement, undo/redo, reload and draft conflict.
  Exact retries do not duplicate reservations or graph edits.
- Separate-connection writer/cleanup race winners; unattached-upload cleanup;
  retained draft/version/case/run protection; last-reference release; preview
  expiry; restart/storage failure during cleanup; workspace purge and exactly-once
  charge release after physical erasure.
- HTTP 5xx/post-dispatch loss still produce the appropriate unknown outcome and
  explicit F09 recovery; no automatic retry or scanning claim.
- Desktop/phone visual inspection, keyboard, reduced motion, full mocked journeys,
  shared contract generation when changed, root dependency/architecture checks and
  existing CI jobs. Local containers qualify neither production nor external access.

## Rollback and later work

Ship readers/reference protection before UI. Preserve inline behavior and accepted
file descriptors. Pause new attachment/admission deliberately if needed; retain
readers and lifetime protection while accepted owners exist. Generic upload,
finalize/download and abandoned-upload cleanup stay operational.

The approved follow-up below covers bounded CSV/JSON reading and multipart.
Bigger files via streaming or paging are the next file improvement, separately
scoped after this slice. Asset discovery, scanning and all
artifact-aware step recovery remain later work.
No production rollout is included.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Owner accepts consumer, budget, opaque-file policy and reference lifetime.
- [x] ADR 075 accepted; decision PR [#291](https://github.com/vigani1/pertexo/pull/291) merged green.
- [x] Consumer contracts and writer/cleanup race model implemented locally.
- [x] Consumer independently qualified with real database/storage and owned HTTP destination.
- [x] Frontend implemented and inspected at desktop/phone widths.
- [x] Local integrated acceptance and retention-safe rollback behavior recorded.
- [x] Consumer PR merged; natural main checks inspected.
- [x] Upload UI PR merged; natural main checks inspected.

Evidence (2026-10-14): the accepted decision merged in #291 at main
`375f35650e8826238c595f3ec495379e3939834b`; PR CI 38627247775 and CodeQL
38627247795 passed. Consumer/lifecycle work is qualified and merged in #292. Eight real PostgreSQL
owner/race/preview/isolation cases pass; the existing real-store worker fixture
writes, verifies and sends 70,000-byte and 1,048,576-byte files to an owned HTTP
server, independently checking received length/hash/type. The final instrumented local read-and-native-byte-comparison observations were
approximately 21 ms for 70,000 bytes and 96 ms for 1 MiB. The latter retained
about 6.3 MB of array buffers at that observation; the test-process lifetime RSS
maximum includes the runner, imports, migrations and assertions, not just the
read. These are not service guarantees. S3Mock
alone does not qualify real provider signatures. Full `pnpm check`, the complete unit suites run sequentially, 161 mocked browser
journeys, eight PostgreSQL owner/race cases, three real storage/HTTP cases and
22 authenticated artifact-API regressions passed. The consumer PR merged; browser upload/signature evidence is recorded below. Storage-off routes now retain normal
auth/role/CSRF checks and return a clear `artifact.unavailable` response without
creating upload reservations.

Natural main CI 38629983430 after the decision-only PR failed in the existing
owned automation-token browser journey; CodeQL 38629982957 passed. The exact
journey passed twice locally. Its credential-safe diagnostics now retain only
allowlisted operation names/public problem codes; redaction regressions pass.
The intermittent failure has not been reproduced or claimed fixed. Consumer
CI and its natural postmerge result must be inspected independently. See [file behavior](../guides/files.md).

Upload UI evidence (2026-10-14): consumer/lifecycle PR [#292](https://github.com/vigani1/pertexo/pull/292)
merged green at `d6ca647cfba69f269179f9094336c7d165a63aa8`. Both ordinary-browser
entry points pass against an owned cached RustFS 1.0.1, including signed PUT/CORS,
forged-signature refusal, 1 MiB invalid-UTF-8 binary data, an empty file, default
MIME type, finalization, save/reload/publication, undo/redo and actual worker HTTP
consumption. Each workflow also sends the first response artifact into a second
HTTP request. The independent target's four hashes match the binary, `{}`, empty
bytes and `{}`. The same journeys pass with the existing CI S3Mock service;
S3Mock does not qualify signature validation. The existing e2e job now runs them,
with exact object-store container/port attestation; no CI job or service definition was added.

Observed 1 MiB browser select-to-ready time was roughly 0.13–0.25 s locally. One
CDP observation increased backing storage from about 1.9 MB to 5.4 MB, while the
whole editor heap was changing too. This includes browser/crypto/network copies,
is not peak allocation or an SLA, and is not a zero-copy claim. Phone dialogs
scroll within the viewport; keyboard controls and reduced-motion rendering are
qualified. React Doctor's changed scan reports 100/100 with no findings. Full `pnpm check`, 1,990 API / 733 worker / 1,173 web unit tests, 161 mocked
browser journeys and both real browser cases pass. The final web build/lint/types
and changed React Doctor scan also pass after the keyboard/lifecycle fixes.
Backend natural main CI 38641937383 (including ARM publication) and CodeQL
38641937323 pass. Upload UI PR [#293](https://github.com/vigani1/pertexo/pull/293) merged green at `e9139241f1504a51ba176fde000a5b4310b25fac`. Latest-head PR CI 38649971227 and CodeQL 38649971228 passed. Natural main CI 38652300620 and CodeQL 38652300536 passed. Screenshots and
usage examples are in [the file guide](../guides/files.md).

The upload dialog keeps its opener mounted while target changes close/cancel
the local session. Desktop and phone keyboard insertion/focus return are checked
through the ordinary editor panels. Destination fields and replacement consent
remain locked during the exact-version contract read; cancel fences late insertion.

The queued insertion callback checks its request/target before invoking the
owner, as well as after awaiting it. A regression reproduces a target change
between confirmation and the callback: no owner mutation may run with an aborted
request. This complements cancellation during hashing/transfer/contract reads.

A pre-push route-loading test exposed an existing detached-heading race across the loading-to-sign-in swap. Its three sign-out assertions now use the existing same-pass visibility helper; no production authentication behavior changed. The complete pre-push API, worker and web suites passed afterward.

## Approved follow-up — Read file and multipart (2026-10-15)

**Status: owner approved implementation on 2026-10-15.** The first release above
remains complete. The owner accepted this follow-up and the ADR 075 amendment
with the three revisions recorded below. Reconciled against main
`4800013813f8927ced695c1fad1b8a1c0b79beb5`. Use one implementation PR per part
below, in order; merge only with green CI. No new subsystem,
service, role, table, queue, storage backend or CI job is required.

### Current seams and decisions to review

- `NodeArtifactRuntime.read` and the worker's `attempts/artifacts/read.ts` already
  bind the workspace, require available metadata, match the complete fingerprint
  and verify all bytes. Reuse this path for both consumers; neither parser nor
  HTTP encoder may query SQL/S3 directly. Reuse `artifact_input` capability.
- List operations use `COLLECTION_MAX_ITEMS` (4,998), derived from the existing
  SDK limits: 1 MiB JSON, depth 64 and 10,000 members. Import that rule, not a
  second literal cap. Member/byte limits can reject wide records below 4,998.
- Workflow `ValueSource` maps one entire top-level input field. It has no nested
  object/array mapping constructor. Multipart part metadata/order will therefore
  live in HTTP config; part values use the existing flat input mappings. Do not
  invent nested graph mappings or generate JSONata behind the user's controls.
- F09 artifact restrictions remain unchanged. Read file is safe, so temporary
  storage failures already use the engine’s automatic retries within the same
  run and existing attempt budget. Malformed content needs a corrected file and
  a new run; a special recovery exception adds little value here. File-aware
  step recovery stays later work, with no recovery-engine/acceptance changes.
- Attempt completion already has `node_attempts.error_summary`, but the
  `executor_failure` completion variant drops it and run views expose only a
  classification code. Delivering useful parser positions requires the small,
  explicitly sanitized diagnostic path below; throwing a detailed Error alone
  would not deliver that information to the person.

### Owner revisions — 2026-10-15

The owner requested these changes to the proposal: defer the special Read file
recovery exception, enable conservative CSV value conversion by default, and
make limits/split-file guidance visible. They are incorporated below. The owner
approved implementation of the revised plan on 2026-10-15.

### Limits people see

Use **1 MB** in human-facing copy, with the exact existing **1 MiB (1,048,576
bytes)** bound in help/details. No byte or item limits change.

- Beside Read file’s upload/configuration controls and in `docs/guides/files.md`, say:
  “Files up to 1 MB. About 4,996 rows through Filter and Summarize, fewer for
  wide rows.” This is a rough end-to-end guide, not a guaranteed CSV row count;
  long cells, column count and downstream configuration also consume the value
  envelope. Keep the separate 4,998-item technical cap.
- Beside multipart parts and its file-upload action, say: “The whole request
  must fit in 1 MB, including form headers. A full 1 MB file won’t fit.”
  Known literal-size estimates remain advisory; actual wire bytes decide.
- File-size, row/member/depth/output-size and multipart-size failures must give
  an action, not just a number. Examples: “File is larger than 1 MB. Split it
  into smaller files and run them separately”; “Parsed data is too large. Split
  the file into fewer rows or columns and run the files separately”; “Multipart
  request is larger than 1 MB including form headers. Use a smaller file or
  split it for separate uploads accepted by your destination.” Keep safe
  numeric positions/counts where available. Malformed-content errors instead
  explain what to correct; splitting is not a cure for broken quoting/JSON.
- Show the applicable limits before selection/configuration, then the corrective
  message at the failed step. Persist approved summaries through the existing
  diagnostic path so reload preserves the advice. Qualify visible copy in
  desktop/phone controls, failure details and guide examples.

**Next file improvement:** bigger files via streaming or paging, with a separate
plan that preserves bounded worker memory and per-step values. Record it now;
this slice adds no automatic splitting, batching, reassembly or paging machinery.

### Part 1 — Read file, as one complete vertical slice

**Contract and placement.** Register `core.read_file@1`, displayed as **Read
file**, in `packages/nodes-core/src/data/read-file/`. Follow the existing
`definition.ts`, `validation.ts`, `executor.ts`, `index.ts` shape, with private
`parse-json.ts`, `parse-csv.ts` and `conversion.ts` only as their responsibilities
require. Public/index imports contain schemas/manifests only; parser dependencies
stay in the `/server` dependency graph. Add the normal definitions/executors,
platform catalog, presentation/default-config and portable-definition coverage.
No separate file-processing package or parser in the engine/browser.

Input is `{ file: <existing kind: 'artifact' descriptor> }`. Configuration is a
strict union: `{ format: 'json' }` or
`{ format: 'csv', delimiter: ',' | ';' | '\t', convertValues: boolean }`.
Default new steps to CSV/comma with `convertValues: true`. The CSV schema
defaults an omitted conversion option to true, and the editor writes that choice
explicitly. Users can select false to keep every cell as text. JSON does not
accept CSV-only options. An explicit format chooses the parser; extension and
MIME do not auto-select it.

Output is the **parsed JSON value itself**, without a wrapper. CSV returns an
array of objects; JSON may return an object, array or scalar. Map a CSV result
into Filter's `items` using the Read file output path `$`. JSON objects can use
an explicit array path such as `$.orders`. No binary output, spreadsheet guessing,
flattening, silent truncation or successful partial result.

**Read and bounds.** Use the existing scoped reader with
`ARTIFACT_INPUT_MAX_BYTES`, fully verifying the file before parsing. Decode UTF-8
strictly and tolerate one leading UTF-8 BOM for either format. Invalid UTF-8,
UTF-16 and compressed files are not silently repaired/decompressed. Release
streams and zero owned byte buffers on every exit; decoded strings/JSON and
library copies are GC-managed, so make no secure-erasure or zero-copy claim.

Require file bytes at most 1,048,576. Parsed arrays, including nested JSON arrays,
contain at most the shared 4,998-item limit; the complete result must pass the
existing SDK byte/depth/member inspector. Also qualify the ordinary downstream
input envelope, which includes config/connection fields: a maximum-sized output
is not a promise it fits every next step. CSV conversion tracks row/member and
serialized-byte growth as records are produced and stops before retaining an
oversized result. Reuse the SDK bound implementation for final admission; do not
raise global limits or create a competing JSON validator.

JSON uses native `JSON.parse`, without a reviver. Standard JSON semantics apply,
including last-key-wins for repeated object keys; finite-number admission and
all container bounds remain authoritative. Empty/whitespace-only JSON fails.
Reject an unrepresentable numeric result rather than returning NaN/Infinity.

**CSV rules.** Pin **`csv-parse` 7.0.3** (MIT; registry metadata currently lists
no runtime dependencies) in nodes-core. Its documented strict quoting, record
limits, record context and error positions are safer than maintaining a second
CSV state machine. Use its Node stream API over chunks of the already verified,
bounded bytes, not an object-store/network streaming feature. `pipeline` owns
cancellation/teardown/backpressure. Record callbacks check cancellation,
convert and accumulate accepted rows within the budget before parser buffering
can accumulate unbounded rows; the pipeline drains to completion. No parsing worker, cache or
extra stream-transform dependency.

- Delimiter is selected explicitly. RFC 4180 double-quote/escaped-quote rules,
  quoted delimiters and quoted multiline fields work with comma, semicolon or
  tab. Accept CRLF, LF and CR record separators; preserve separators inside
  quoted fields. Disable relaxed quotes, relaxed column counts, comment syntax,
  error skipping, trimming, auto-casting and date casting.
- The first nonempty record is the required header. Skip only completely empty
  physical records outside quotes; retain whitespace-only records, quoted empty
  values and records containing delimiters. A terminal separator creates no
  extra row. A valid header with no data rows returns `[]`; an empty file fails.
- Header names retain exact spelling/whitespace. Reject empty or whitespace-only
  names and exact duplicate names, with their column numbers. Do not silently
  rename, merge or drop columns. Every data record has exactly that many fields;
  trailing empty fields are real values. Preserve row order.
- Construct own data properties safely, including `__proto__`, `constructor` and
  `prototype`; these names must never mutate prototypes or disappear. Apply the
  platform's existing own-property mapping rules, not a second path resolver.
- Conversion is on by default. With `convertValues` on, quoted and unquoted cells
  follow the same rule: exact lowercase `true`/`false` become booleans; otherwise
  only the JSON decimal-number grammar is a numeric candidate. No trimming,
  grouping separators, hexadecimal, leading plus, leading-zero integers,
  currency/date/null conversion or locale parsing. Convert only to a finite
  JavaScript number whose value, when integral, is a safe integer; other cells
  remain strings. Decimal fractions use JavaScript/JSON number precision.
  `00123`, `9007199254740993`, `1e999`, `TRUE`, `null` and empty cells stay strings;
  `12.5`, `-3` and `false` convert. With conversion explicitly off, every cell
  remains a string. Headers never convert; SDK normalizes `-0`.

**Clear, safe failures.** Use a closed file-input diagnostic on the existing
SDK executor-failure path: approved reason plus optional positive record/line/
column or bounded character offset/count. Reasons cover unavailable/integrity/
file-size, UTF-8, JSON syntax, CSV quoting/columns/header and item/value bounds.
Worker-owned formatting produces fixed sentences plus numbers only. Never copy
parser messages, cells, headers, filenames, URLs or arbitrary Error/cause text.
Example: “CSV record 4 has 3 fields; expected 2.” Logical CSV records count the
header as 1; physical lines are reported separately for multiline fields. JSON
reports line/column or character position only where the native parser supplies
reliable numeric evidence; otherwise say malformed JSON without a guessed offset.

Carry that approved summary through `executor_failure` into the existing
`node_attempts.error_summary`, preserving idempotent completion comparisons.
Expose it in the existing authorized run/node-detail read and shared contract;
render it beside the current step classification after reload as well as during
live inspection. Expose summaries only for the new closed file-input diagnostic
codes; do not start returning arbitrary historical error-summary strings.
Select the current attempt under the existing workspace scope;
no new endpoint, event type or SQL column. Other exceptions retain current
redaction. Do not return errors as successful JSON or encode coordinates in a
code string. Regenerate affected contracts/OpenAPI in the same part.

**Effects and recovery.** Manifest: transform family, `retryClass: 'safe'`,
`resourceClass: 'io'`, existing bounded-JSON policy and `artifact_input` capability.
There are no connections, external-HTTP capability or external effects. Invalid
contents/integrity/limits are definite failures, operational storage failures use
existing safe pre-effect retry policy, and cancellation remains cancellation.
Do not automatically retry malformed content.

Keep ADR 072 and the recovery machinery unchanged: no Read file exception,
file-aware prefix copying or new recovery admission/locking path. Existing
same-run automatic retries handle temporary storage failures for this safe step
within the configured retry budget. They neither repeat earlier completed HTTP
effects nor require new recovery logic. A malformed file needs corrected content
in a separately started run; retrying the same immutable bytes cannot repair it.
File-aware “Retry from this step” remains later work under current F09 refusals.

**Editor and real qualification.** Add the catalog entry, format/delimiter/
conversion controls and an input-local Upload file for the Read file `file`
mapping through `features/artifacts/public.ts`. Reuse the current target/scope
cancellation, explicit finalized descriptor insertion, ETag/scratch barriers and
one undoable edit. Existing run-input/previous-output mapping choices remain.
No browser file preview/parser. Run through the ordinary compiled worker:

`upload CSV → Read file → Filter items → Summarize items → Stop run`

Use `currency,amount,paid` with `EUR,12.5,true`, `EUR,7.5,true`, `USD,9,true`,
`EUR,100,false`; leave the new step’s conversion default untouched, Filter
`$.paid == true`, Summarize `$.amount` grouped by `$.currency`. Independently assert EUR count 2/sum 20 and USD count
1/sum 9, exact retained outputs and successful Stop. Also consume an earlier
owned HTTP-response artifact and run-input file, qualify automatic within-run
retry after a transient storage failure without repeating the earlier HTTP
effect, and prove malformed-content diagnostics and split-file advice on limit
failures survive a page reload.

### Part 2 — Multipart HTTP, as one complete vertical slice

**One authoring representation.** Extend the existing `http.request@1` config
with optional `multipart: { parts: [...] }`; absence preserves the current raw/
inline path. Presence selects multipart. Each ordered part contains a stable
`inputKey` (`part_` plus generated UUID), `name`, `kind: 'text' | 'file'`, optional
`filename` and optional `contentType`. Its value is a normal top-level input
mapping under that key: a string for text or the existing descriptor for file.
Part identity is independent of editable field name and position. Duplicate
field names are allowed and order is preserved, including interleaved files.

Require 1–64 parts, unique input keys, field names 1–128 UTF-8 bytes and explicit
filenames 1–255 UTF-8 bytes. Reject control characters in names/filenames and
path separators, `.` or `..` as filenames; escape protocol quoting through the
encoder. Validate content types as bounded MIME header values without CR/LF,
not arbitrary part-header maps. Values are not coerced or JSON-stringified.
Absent filename stays absent for text; file parts default to `file`. An explicit
filename is allowed on either part type. Content type defaults to
`text/plain; charset=utf-8` for text and the verified artifact media type for
files; an explicit override is metadata only and does not alter bytes.

Multipart refuses `input.body`, missing/extra part values, wrong types and
GET/HEAD before dispatch. Raw mode refuses stray part mappings. Keep the current
strict input rules for existing requests; the new part-key rule is scoped to
this representation. No parallel multipart JSON body shape, graph migration,
HTTP v2, new ValueSource kind or hidden expression compiler.

**Encoding and dispatch.** Pin **`form-data` 4.0.6** (MIT) in integrations for
its Buffer-only encoder path. This exact version includes the upstream
cryptographic-boundary and header-parameter escaping fixes. The extra dependency
is justified: native FormData cannot assign an independent Content-Type to a
text part while keeping an omitted filename, and handwritten MIME framing would
own security-sensitive quoting/boundaries unnecessarily. Lock its transitive
dependencies and run the existing audit. Do not use its `submit` or network
APIs; the sole outgoing path remains the existing secure byte-body HTTP client.

**Owner-approved encoder adjustment, 2026-10-15.** The library's `getBuffer()`
repeatedly concatenates the accumulated form: a measured 64-part, 1 MiB body
allocated about 200 MB cumulatively. Instead, pipe the Buffer-only encoder into
one preallocated, exact-length buffer through its public API, with cancellation,
length checks and zeroing on failure. The prototype preserved all 64 parts and
exact file bytes with about 2 MB of array-buffer growth. This replaces the
no-stream-API restriction solely for bounded in-memory assembly; it introduces
no streaming file reads, larger bodies or alternative network transport.

Cheap preflight checks sum actual UTF-8 text lengths and declared file lengths,
counting a repeated file for every occurrence. If that lower bound reaches 1 MiB,
stop before storage reads. Read each file sequentially through the existing
scoped reader, match/verify it and check cancellation. Retain at most the bounded
aggregate, not 64 separate 1 MiB allocations or concurrent reads. No file-read
cache. Build ordered string/Buffer parts using only validated options. Generate
the boundary, get exact encoded length and materialize one bounded byte body;
reject if framing plus content exceeds **1,048,576 bytes**. Recheck actual final
byte length and use it as transport authority. Validate that the delimiter does
not occur in payload bytes; regenerate on collision with a bounded attempt count,
then fail before dispatch. Never accept a caller-supplied boundary.

The budget includes every part header, boundary and closing CRLF, not just file
bytes. A 1 MiB file therefore cannot fit in a multipart request at this limit;
show that plainly instead of silently increasing it. Keep existing URL/outer
HTTP-header limits. Measure maximum successful wire body, over-limit refusal,
CPU/time and peak-relevant byte copies before proposing any larger limit.

Generate Content-Type from the encoder and preserve its boundary. A configured
or connection-supplied outer Content-Type conflicts and must fail clearly;
never silently discard a credential header. Keep existing header collision,
connection/current-secret checks, redaction, SSRF, redirects, deadlines,
before-dispatch fencing and prior-unresolved-dispatch behavior. Clean up owned
buffers on encoding, cancellation, connection and transport exits. Existing
unsafe HTTP effects, 5xx/network-loss unknown outcomes and explicit F09 warnings
are unchanged. Neither parser nor encoder sends a request itself.

The deliberate filename is durable **part metadata**, not part of a file
reference. Only an explicit user-entered filename is stored; do not persist the
browser's original local filename automatically. Generated boundaries, signed
URLs, file bytes and browser File objects remain transient. Existing reference
collection already traverses literal part mappings: qualify retention and both
writer/cleanup race winners instead of adding another ownership system.

**Editor placement.** HTTP Inputs composes raw/multipart modes. Part metadata,
order and values have one authority in the scoped editor draft. Each row uses
the existing mapping-source controls and a human field-name label; upload uses
`features/artifacts/public.ts` for file parts. No second form store. Add, remove,
change kind and reorder are atomic undoable edits; reordering keeps stable keys
and their mappings. Removing a part removes only its mapping/metadata, not the
shared file. Incomplete parts use existing scratch/save/publish barriers.
Switching modes or replacing a populated value asks before discarding it;
Cancel preserves the draft, Undo restores it. A field/part/node/workspace change
fences pending upload insertion. Known literal sizes show a human-unit estimate,
while runtime actual-byte validation remains authoritative.

Use keyboard Move up/Move down alongside any pointer affordance. Preserve focus,
visible labels, error associations, Weft Status/threads, scrolling at 375px and
reduced motion. Keep these controls feature-owned in inspector `http-body/`
with a pure model helper; do not grow the existing Inputs tab into a form engine.
The integration's multipart contract/encoder live under `http-request/multipart/`;
Node-only encoder imports never enter the browser-safe catalog.

Qualify browser edit/upload/reorder/undo/save/reload/publish/run against an owned
local destination. An independent server parser checks the **ordered** received
fields, repeated names, filenames/content types, exact text (including newlines),
empty and binary bytes, hashes, closing boundary and total wire-body length.
Never convert the result to a map that loses duplicate-name order. Include
run-input and prior HTTP-response files. No real provider account or service.

### Part 3 — Guides and closure

Update `docs/guides/files.md` with the currency CSV pipeline, JSON object/array examples,
conversion/strict-header/error rules, and an API form with a text field plus
file part. Show the normal mapping paths and named upload workflow. Explain the
full multipart wire budget, explicit filename metadata, no scanning guarantee,
safe Read file versus unsafe HTTP effects, unchanged F09 file restrictions,
visible rough limits and split-file error guidance. Record bigger files via
streaming or paging as the next file improvement.
Update the F04 tracker and roadmap from planned to delivered only with actual
merged PRs and inspected main CI. Keep first-release evidence above as history.

### Placement and checks across parts

| Owner | Follow-up responsibility |
| --- | --- |
| `nodes-core/src/data/read-file/` | File decoding/parsing/conversion and transform definition/executor |
| `node-sdk` artifacts/executor contracts | Reuse reference/read/JSON limits; closed diagnostic carried by existing failure |
| Worker `attempts/artifacts/` and attempt completion | Existing checked reader; trusted diagnostic formatting/propagation |
| Database `attempts/completion/`, existing run queries; contracts execution schemas/OpenAPI | Persist approved summary in existing column and expose authorized detail; no new endpoint |
| `integrations/src/http-request/` and private `multipart/` | Mode/part contracts, bounded encoding and existing secure dispatch |
| `nodes-core` registrations and `node-catalog` | Current identities, capability and portable projection |
| Web catalog, editor inspector and run-detail owners | Controls/presentation/mapping composition and safe diagnostics |
| Existing worker/API/live-browser fixtures | Owned stores/endpoints and independent byte/output assertions |

No planned moves. If a touched folder needs grouping, make a separate move-only,
buildable commit with import/check updates, then logic. Each commit follows the
owner author/no-coauthor/hook rules and passes lint, strict types and units. Each
PR reports Moved/Removed/Lines and updates only changed plan claims. Use existing
CI jobs; fix failures forward. Relevant parts also run mocked e2e, real owned
integration, shared contract checks and changed-code React Doctor; inspect
rendered desktop/phone states and attach screenshots for visible changes.

Required cases, beyond the successful workflows:

- JSON scalar/object/array/null, BOM, malformed and empty JSON, invalid UTF-8,
  numeric overflow, depth/member/byte boundaries, nested array caps; no MIME sniff.
- All CSV delimiters, quoting/escaped quotes/multiline/line endings, exact and
  duplicate/blank/prototype-like headers, ragged rows, empty cells/blank records,
  default-on, omitted-option and explicit-off conversion, plus precision and
  leading-zero cases. The currency pipeline works without changing the conversion default.
  Read file accepts/persists 4,998 one-column records and rejects 4,999. For the full maximum-row pipeline,
  use 4,996 one-column records with numeric Filter comparison and ungrouped
  Summarize: Filter admission uses 2N+7 members (9,999 at that count), so 4,997
  would fail its envelope even though Read file can return them. Qualify that
  rejection separately; wide records can fail earlier. Do not enlarge the cap
  or strip data to make a maximum-sized result fit a downstream input.
- Exactly 1 MiB input, one byte over, worst-case dense delimiters/long fields,
  serialized JSON escaping/key repetition expansion and measured CPU/memory.
- Diagnostic redaction with unique secret-like sentinels in cells, headers and
  thrown parser/store errors: none reaches summaries, API payloads, events or
  logs; only approved reasons and numeric positions survive reload.
- Existing foreign/missing/pending/deleting/preview/integrity/storage-failure
  and cancellation cases through each new consumer, not just a fake byte reader.
- Read file’s existing automatic within-run storage retry for literal/run-input/
  prior-response descriptors, with no repeat of earlier completed HTTP effects.
  Malformed input fails definitely; current F09 artifact refusals and HTTP
  acknowledgement rules stay unchanged. No new recovery code or copied owners.
- Visible file/row/multipart limits, split-file advice on each size/envelope
  refusal, and persistence of that guidance after reload; malformed data keeps
  correction-specific advice. Desktop/phone layout and guide copy agree.
- Multipart exact final body at the byte ceiling and one over, repeated names/
  files, empty values, Unicode, explicit/default names/types, header injection,
  boundary collision, GET/HEAD, Content-Type conflict and stale part mappings.
  Failed preflight/verification must cause zero destination requests.
- Before-dispatch vs post-dispatch failure, cancellation/connection rotation,
  5xx/network loss, original raw UTF-8/base64/file request regressions, browser
  upload reconciliation, reorder/undo/conflict/reload, keyboard and phone scroll.

Use attested owned fixtures and existing cached images only. No production
rollout, Docker image download, new account or external effect is part of this
slice. Re-check dependency releases/advisories before implementation; a necessary
choice outside this plan returns to the owner for review.

### Follow-up tracker

- [x] Reconcile code seams, constraints and dependency/protocol sources.
- [x] Owner accepts this follow-up and ADR 075 amendment (2026-10-15).
- [x] Part 1 merged green in [#296](https://github.com/vigani1/pertexo/pull/296); default-on CSV pipeline, diagnostics, visible limits and automatic retry qualified.
- [x] Part 2 merged green in [#297](https://github.com/vigani1/pertexo/pull/297); exact multipart bytes and editor journeys qualified.
- [x] Part 3 guide, examples, screenshots and roadmap updated. The closing documentation PR records its CI/merge and subsequent natural-main CI/ARM receipt.

Next file improvement: **bigger files via streaming or paging**, separately
planned after this slice. Other later work: email attachments, webhook file
ingestion, Excel/other formats, a file browser, scanning,
all artifact-aware step recovery (including Read file) and asset management.
None is an implicit dependency of these parts.

### Part 1 implementation and local qualification — 2026-10-15

Read file is implemented with Node-only `csv-parse` 7.0.3, native JSON parsing,
the existing scoped worker reader and SDK value bounds. CSV conversion defaults
on, the editor stores that choice explicitly, and the returned array maps
directly into list operations. Parser failures carry only closed reasons and
bounded numeric coordinates; the worker formats them into the existing attempt
summary. The authorized run read exposes only this diagnostic code. Completion
replay compares the persisted summary; no recovery eligibility changed.

Local evidence, confirmed by green CI and merge of PR #296:

- Core: 199 tests pass, including exact 1 MiB JSON, UTF-8/BOM, all delimiters,
  quoted multiline cells, malformed quoting/width/headers, conservative conversion,
  prototype-like own keys, cancellation, nested-array and expansion bounds.
- The 4,996-row numeric Read → Filter → Summarize → Stop pipeline completes
  in approximately 85–109 ms locally; 4,997 rows fail the unchanged downstream
  envelope. Read alone admits 4,998 one-column rows and refuses 4,999.
- Database: all 17 attempt integration tests pass, including diagnostic storage,
  duplicate completion and changed-summary refusal. Worker file tests and upload
  unit tests pass; the full repository unit suites passed.
- All 161 mocked browser tests pass. Six live journeys use the attested isolated
  PostgreSQL/Redis fixture and pinned, cached RustFS 1.0.1 with real signatures:
  original raw-file consumers, default-on CSV currency totals, malformed-file
  diagnostics after reload without a redaction sentinel, manual JSON file input,
  and JSON from an earlier HTTP response file. A controlled temporary read outage
  yields two Read attempts; the earlier HTTP step executes once, confirmed by
  the independent destination's exact request hashes.
- Desktop (1280 × 768) and phone (375 × 768) Read file setup and diagnostic
  screenshots were inspected locally. Changed-scope React Doctor includes all
  changed frontend source files and reports 100/100. Dependency audit reports
  no known production vulnerabilities.

The final mocked and live browser runs are sequential: overlapping their shared
Playwright output directory caused an initial local trace-artifact collision;
one overlapped publication also reported a temporary validation outage. The
isolated journeys pass without application retries, relaxed assertions or
longer timeouts. The production key/storage configuration is unchanged.

### Follow-up sources checked on 2026-10-15

- [CSV parser options](https://csv.js.org/parse/options/),
  [record callbacks](https://csv.js.org/parse/options/on_record/),
  [stream/async iteration](https://csv.js.org/parse/api/async_iterator/) and
  [errors](https://csv.js.org/parse/errors/): syntax, bounds and numeric context;
  Pertexo owns conversion, header policy and sanitized error copy.
- [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180.html) and
  [RFC 7578](https://www.rfc-editor.org/rfc/rfc7578.html): CSV quoting and ordered
  multipart fields, filenames and content types.
- [form-data API](https://github.com/form-data/form-data),
  [4.0.6 changes](https://github.com/form-data/form-data/blob/master/CHANGELOG.md),
  [boundary advisory](https://github.com/form-data/form-data/security/advisories/GHSA-fjxv-7rqg-78g4)
  and [parameter-escaping advisory](https://github.com/form-data/form-data/security/advisories/GHSA-hmw2-7cc7-3qxx).
  Registry metadata checked read-only for csv-parse 7.0.3 and form-data 4.0.6;
  this planning PR installs neither dependency.


### Part 2 implementation and local qualification — 2026-10-15

Multipart uses one optional HTTP config and stable ordinary input mappings.
The browser shares the reviewed integrations-root schemas; the existing source
entry walker now also checks that root for Node dependencies. The encoder stays
on the Node-only executor path and the secure HTTP client remains the sole
transport. CSV/Read file and F09 rules are unchanged.

The owner-approved collector uses public `pipe()` and `finished()` with a bounded
Writable: `pipeline()` cannot observe the legacy CombinedStream lifecycle.
Every input is an already verified Buffer; cancellation/errors destroy the
encoder and collector, failed output and owned part buffers are cleared, and
exact encoded length is checked before dispatch. No private library fields,
handwritten MIME framing or provider-network helper is used.

Local evidence before PR review (Part 2 merge remains unchecked above):

- Forty-two focused multipart cases pass, covering metadata/type/key validation,
  duplicate-name order, Unicode/newline text, exact empty/binary bytes, filenames,
  boundary collision regeneration, lower-bound refusal before reads, full 1 MiB
  wire body and one byte over, cancellation, incomplete/failed assembly,
  credential Content-Type conflict and prior unresolved dispatch. Actual secure
  client dispatch preserves unknown outcomes for 5xx and post-dispatch network
  loss and releases owned request bytes.
- The maximum 64-part wire body has 9,288 framing bytes in the measured fixture;
  assembly plus independent verification took about 3–4 ms locally. Observed
  array-buffer growth before parsing was 2,096,324 bytes; GC can lower this
  observation in other runs. The earlier `getBuffer()` experiment allocated
  200,453,960 bytes cumulatively, justifying the approved collector.
- Seven real browser journeys pass against the attested isolated API/worker/
  PostgreSQL/Redis and cached RustFS with real signatures. The multipart journey
  edits, uploads, keyboard-reorders, cancels replacement, undoes/redoes, saves,
  reloads, publishes and runs at desktop/375px widths. The independent destination
  uses dev-only `@fastify/busboy` 3.2.3 to parse ordered repeated names, exact UTF-8/newline text, file metadata/hashes,
  binary/empty files, run-input and prior-response files, closing delimiter and
  total wire length. Its request hashes also confirm prior effects execute once.
- Changed-scope React Doctor includes all 13 changed frontend source files and
  reports 100/100 without suppressions. The form's existing scratch callbacks own
  edits; no effect mirrors live field validity into parent state. Part metadata
  and value controls compose the existing mapping/upload primitives. Locally
  inspected screenshots are in `docs/images/f04/multipart-*.png`.

The independent owned receiver pins dev-only `@fastify/busboy` 3.2.3 (MIT),
following Node/Undici's recommendation against server-side `Request.formData()`.
It hashes bounded raw part streams in arrival order, retaining repeated names
and exact bytes; production uploads still use form-data only for encoding.
The parser includes the boundary-length and CR/LF fixes documented in
[GHSA-xjh9-v7x6-24jw](https://github.com/fastify/busboy/security/advisories/GHSA-xjh9-v7x6-24jw)
and [GHSA-gxm5-99cw-xjw9](https://github.com/fastify/busboy/security/advisories/GHSA-gxm5-99cw-xjw9).
This is test-fixture parsing, not a webhook ingestion path or production parser.

- The 16 database lifetime integration cases pass for literal and multipart
  mapping shapes, including retained drafts/versions/input cases, both cleanup
  race winners, preview refusal, workspace isolation and tampered metadata.
- Natural main CI [38669520160](https://github.com/vigani1/pertexo/actions/runs/38669520160)
  passed after rerunning its failed service job. Its initial failure exposed an
  existing fixture race: the live coordinator's deadline scanner can claim the
  same wakeup before the test's explicit scanner. Qualification now stops the
  owned child before expiring that run and asserting scanner ownership, then
  restarts through the existing recovery path. No production scheduling changed.
- Production dependency audit is clean. An additional all-dependencies audit
  reports the pre-existing dev-only `knip → fast-glob → micromatch → braces`
  advisory GHSA-vfj7-8cjw-p6xm. The configured registry still publishes 3.0.3 as
  latest; an attempted scoped lockfile update cannot select the advisory's
  not-yet-published 3.0.4. No vulnerable dependency was introduced by this slice;
  a maintained tooling update remains follow-up work.

The final local check and full repository unit suites passed (9,055 cases),
followed by two additional C1-control metadata refusals (538 integration-package
unit cases in total). All 163 mocked browser tests pass, including the existing
publication save barrier: an unfinished part reports its correction and sends
no publish request. The separate fresh-worker deadline qualification also passes.


### Part 3 — Guide and closure — 2026-10-15

Read file shipped in [#296](https://github.com/vigani1/pertexo/pull/296), and
multipart shipped in [#297](https://github.com/vigani1/pertexo/pull/297), each
rebase-merged after all PR checks passed. Part 2's CI is
[38674995568](https://github.com/vigani1/pertexo/actions/runs/38674995568), with
[CodeQL 38674995543](https://github.com/vigani1/pertexo/actions/runs/38674995543).
Its natural main is `410823a652a181014b6274f6e302cc794b4a2cbc`.

`docs/guides/files.md` now documents raw files, Read file JSON/CSV and multipart forms,
including executable currency-summary and API-upload examples, mapping paths,
default conversion, blank-line/header rules, budgets and split-file advice.
The guide retains upload/finalize, access, signature and lifetime instructions.
Nine synthetic browser images remain together in `docs/images/f04/`; the guide
links the Read file and multipart desktop/phone captures used in qualification.

The supported follow-up is complete in code and documentation. No file-aware
recovery exception was added; all later work listed above stays deferred, with
streaming or paging next. CI, merge and the final natural-main/ARM result for
this closing documentation PR are recorded on that PR, after those events occur.
This records qualification, not a deployment or external-service rollout.


### Multipart size-feedback correction — 2026-10-15

Final boundary qualification found that a valid reference to a file larger than
1 MiB failed the multipart input schema before the size-specific preflight.
That gave a generic input error instead of the promised split-file guidance.
Use the existing descriptor's structural bounds for multipart inputs and let
the aggregate preflight reject the request with `multipart_size` before any
file read, credential read or dispatch. Raw-body schema limits stay unchanged.
The editor's shared schema then gives the same split-file advice for a pasted
large reference. Request assembly/preflight use the existing HTTP request-budget
constant; file reads retain the separate artifact-input ceiling. No file-read
or request budget is raised; the existing descriptor format, roles, services
and recovery behavior stay unchanged. This narrowly scoped repair
needs a follow-up PR because Parts 2 and 3 have already merged; history is kept.


Qualification: all 45 multipart cases pass, including the real registry boundary
for a 2 MB reference with zero storage/credential/dispatch calls. The editor model
rejects that same reference with split-file advice. The full repository check and
9,060 unit cases pass; normal exact-byte, 64-part and over-framing cases still pass.

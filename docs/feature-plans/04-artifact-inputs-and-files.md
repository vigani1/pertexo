# F04 — File inputs and artifact lifecycle

Status: first release complete on 2026-10-15; Read file/multipart follow-up proposed below, awaiting owner review.
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
parsing and multipart are proposed in the follow-up below; generated files and
asset discovery remain later work. Undelivered controls stay absent.

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
| `packages/node-sdk/src/executor-contracts.ts` | Scoped server read interface, existing reference | SQL/browser upload |
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

The proposed follow-up below covers bounded CSV/JSON reading, multipart and a
narrow Read file recovery exception. Later work retains larger/streaming bodies,
asset discovery, file creation, scanning and general artifact-aware recovery.
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
CI and its natural postmerge result must be inspected independently. See [file behavior](../files.md).

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
usage examples are in [the file guide](../files.md).

The upload dialog keeps its opener mounted while target changes close/cancel
the local session. Desktop and phone keyboard insertion/focus return are checked
through the ordinary editor panels. Destination fields and replacement consent
remain locked during the exact-version contract read; cancel fences late insertion.

The queued insertion callback checks its request/target before invoking the
owner, as well as after awaiting it. A regression reproduces a target change
between confirmation and the callback: no owner mutation may run with an aborted
request. This complements cancellation during hashing/transfer/contract reads.

A pre-push route-loading test exposed an existing detached-heading race across the loading-to-sign-in swap. Its three sign-out assertions now use the existing same-pass visibility helper; no production authentication behavior changed. The complete pre-push API, worker and web suites passed afterward.

## Proposed follow-up — Read file and multipart (2026-10-15)

**Status: plan only, awaiting owner review.** The first release above remains
complete. This section, including the proposed ADR 075 amendment, does not
approve implementation. Reconciled against main
`4800013813f8927ced695c1fad1b8a1c0b79beb5`. Use one implementation PR per part
below, in order, after approval; merge only with green CI. No new subsystem,
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
- F09 currently rejects descriptors inside inline input/prefix JSON as well as
  artifact-backed stored execution values. Merely marking Read file safe would
  leave common run-input/HTTP-response cases unrecoverable. The narrow exception
  proposed below is part of this review, not permission for general artifact
  recovery. ADR 075 records its precedence over that part of ADR 072.
- Attempt completion already has `node_attempts.error_summary`, but the
  `executor_failure` completion variant drops it and run views expose only a
  classification code. Delivering useful parser positions requires the small,
  explicitly sanitized diagnostic path below; throwing a detailed Error alone
  would not deliver that information to the person.

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
Default to CSV/comma with conversion off; JSON does not accept CSV-only options.
An explicit format chooses the parser; extension and MIME do not auto-select it.

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
cancellation/teardown/backpressure; a bounded async record transform checks the
signal and accumulates accepted rows. Record callbacks enforce limits before
parser buffering can accumulate unbounded rows. No parsing worker, cache or
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
- Values default to strings. With `convertValues` on, quoted and unquoted cells
  follow the same rule: exact lowercase `true`/`false` become booleans; otherwise
  only the JSON decimal-number grammar is a numeric candidate. No trimming,
  grouping separators, hexadecimal, leading plus, leading-zero integers,
  currency/date/null conversion or locale parsing. Convert only to a finite
  JavaScript number whose value, when integral, is a safe integer; other cells
  remain strings. Decimal fractions use JavaScript/JSON number precision.
  `00123`, `9007199254740993`, `1e999`, `TRUE`, `null` and empty cells stay strings;
  `12.5`, `-3` and `false` convert. Headers never convert; SDK normalizes `-0`.

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

Recommend a narrow F09 exception **only when the recovery target is Read file**:
allow complete file descriptors inside otherwise bounded inline original input
and completed-prefix snapshots. Keep artifact-backed whole execution-value
hydration excluded. The pure planner checks shapes/bounds, never workspace
permission. Recovery preview checks availability through the existing artifact
metadata rules; acceptance gathers references from original input and every
copied prefix value and locks/validates their union in stable ID order, in the
same transaction as creating the new run and copied rows. Reuse the existing
reference validator and retention reachability. Never persist a copied owner
first and validate its references later; never hold those locks during byte I/O.

Preserve exact original input/version, prefix provenance, current caller
permissions, capacity, aggregate recovery limits and source-retention fences.
The new run's retained input/copied values protect the files after source details
expire. A descriptor does not authorize another workspace, an expired preview
output, deleted bytes or altered metadata. If deletion wins, refuse recovery;
if recovery wins, cleanup observes the new owner. No effect acknowledgement is
needed for this safe target. All other F09 target eligibility and HTTP effects/
unknown acknowledgements remain unchanged; general file-aware downstream
recovery stays later work. A malformed file can be retried safely but still
fails until a separate edited-version run supplies corrected data.

**Editor and real qualification.** Add the catalog entry, format/delimiter/
conversion controls and an input-local Upload file for the Read file `file`
mapping through `features/artifacts/public.ts`. Reuse the current target/scope
cancellation, explicit finalized descriptor insertion, ETag/scratch barriers and
one undoable edit. Existing run-input/previous-output mapping choices remain.
No browser file preview/parser. Run through the ordinary compiled worker:

`upload CSV → Read file → Filter items → Summarize items → Stop run`

Use `currency,amount,paid` with `EUR,12.5,true`, `EUR,7.5,true`, `USD,9,true`,
`EUR,100,false`; conversion on, Filter `$.paid == true`, Summarize `$.amount`
grouped by `$.currency`. Independently assert EUR count 2/sum 20 and USD count
1/sum 9, exact retained outputs and successful Stop. Also consume an earlier
owned HTTP-response artifact and run-input file, qualify safe recovery after a
transient storage failure without repeating the earlier HTTP effect, and prove
malformed-content diagnostics survive a page reload.

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
dependencies and run the existing audit. Do not use its `submit`/network/stream
APIs; the sole outgoing path remains the existing secure byte-body HTTP client.

Cheap preflight checks sum actual UTF-8 text lengths and declared file lengths,
counting a repeated file for every occurrence. If that lower bound exceeds 1 MiB,
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

Update `docs/files.md` with the currency CSV pipeline, JSON object/array examples,
conversion/strict-header/error rules, and an API form with a text field plus
file part. Show the normal mapping paths and named upload workflow. Explain the
full multipart wire budget, explicit filename metadata, no scanning guarantee,
safe Read file versus unsafe HTTP effects, and the narrow recovery limitation.
Update the F04 tracker and roadmap from planned to delivered only with actual
merged PRs and inspected main CI. Keep first-release evidence above as history.

### Placement and checks across parts

| Owner | Follow-up responsibility |
| --- | --- |
| `nodes-core/src/data/read-file/` | File decoding/parsing/conversion and transform definition/executor |
| `node-sdk` artifacts/executor contracts | Reuse reference/read/JSON limits; closed diagnostic carried by existing failure |
| Worker `attempts/artifacts/` and attempt completion | Existing checked reader; trusted diagnostic formatting/propagation |
| Engine `recovery/`, execution recovery and database `runs/recovery/` | Narrow Read file-target descriptor exception, pure eligibility and atomic reference acceptance |
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
  conversion on/off and precision/leading-zero cases. Read file accepts/persists
  4,998 one-column records and rejects 4,999. For the full maximum-row pipeline,
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
- Read file safe retry/recovery for literal/run-input/prior-response descriptors,
  no repeat of earlier HTTP effects, source-detail retirement, copied-owner
  retention, both cleanup races and missing/foreign/corrupt reference refusal.
  Other recovery targets retain their artifact refusal and acknowledgement rules.
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
- [ ] Owner reviews and accepts this follow-up and ADR 075 amendment.
- [ ] Part 1 merged green; real CSV pipeline, diagnostics and safe recovery qualified.
- [ ] Part 2 merged green; exact multipart bytes and editor journeys qualified.
- [ ] Part 3 examples/tracker/roadmap merged; natural main evidence recorded.

Later work: email attachments, files arriving through webhook ingestion,
larger-file streaming, Excel/other formats, a file browser, CSV/JSON file
creation, scanning, general artifact-aware downstream recovery and asset
management. None is an implicit dependency of these parts.

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

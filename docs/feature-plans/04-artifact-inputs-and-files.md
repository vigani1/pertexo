# F04 — File inputs and artifact lifecycle

Status: consumer merged; upload UI implemented and locally qualified on 2026-10-15.
The owner accepted the HTTP consumer, 1 MiB budget, opaque-file policy and reference
lifetime on 2026-10-14. UI delivery/CI status is tracked below.
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
retention safety, documentation and real integrated qualification. Asset discovery,
CSV/JSON parsing, generated files and multipart requests are later work. Their
absence must not leave enabled placeholder controls.

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

Later, separately scoped: measured larger/streaming bodies, multipart, bounded
asset discovery, CSV/JSON parsing/creation, malware scanning if needed, and
artifact-aware F09 prefix recovery. No production rollout is included.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Owner accepts consumer, budget, opaque-file policy and reference lifetime.
- [x] ADR 075 accepted; decision PR [#291](https://github.com/vigani1/pertexo/pull/291) merged green.
- [x] Consumer contracts and writer/cleanup race model implemented locally.
- [x] Consumer independently qualified with real database/storage and owned HTTP destination.
- [x] Frontend implemented and inspected at desktop/phone widths.
- [x] Local integrated acceptance and retention-safe rollback behavior recorded.
- [x] Consumer PR merged; natural main checks inspected.
- [ ] Upload UI PR merged; natural main checks inspected.

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
qualified. React Doctor's changed scan reports 100/100 with no findings. Full `pnpm check`, 1,990 API / 733 worker / 1,172 web unit tests, 161 mocked
browser journeys and both real browser cases pass. The final web build/lint/types
and changed React Doctor scan also pass after the keyboard/lifecycle fixes.
Backend natural main CI 38641937383 (including ARM publication) and CodeQL
38641937323 pass. Upload UI PR merge and its natural main checks remain pending. Screenshots and
usage examples are in [the file guide](../files.md).

The upload dialog keeps its opener mounted while target changes close/cancel
the local session. Desktop and phone keyboard insertion/focus return are checked
through the ordinary editor panels. Destination fields and replacement consent
remain locked during the exact-version contract read; cancel fences late insertion.

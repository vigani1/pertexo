# F04 — File inputs and artifact lifecycle

Status: approved for implementation on 2026-10-14. The owner accepted the
recommended HTTP consumer, 1 MiB budget, opaque-file policy and reference lifetime.
Created: 2026-09-28. Reconciled against main
`9c095bd258306c2a0fd0b618ceb0a584850e3baf` on 2026-10-14.
Parent: [product roadmap](../product-roadmap.md).
Decision: [proposed ADR 075](../adr/075-workflow-artifact-inputs.md).

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
| Web `features/workflow-runs/` | Manual-input upload composition | Stored browser File objects |

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
Byte progress belongs in a feature-local direct-transfer adapter, not a second
application HTTP client. PUT success leads to finalize, not attachment.

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
- [ ] ADR 075 accepted; decision PR merged green.
- [ ] Contracts and complete writer/cleanup race model implemented.
- [ ] Consumer independently qualified with real database/storage.
- [ ] Frontend implemented and inspected at desktop/phone widths.
- [ ] Integrated acceptance and rollback evidence recorded.
- [ ] Implementation PRs merged; natural main checks inspected.

Evidence: source reconciliation only on 2026-10-14. No F04 code, passing-test,
merge or production claim yet.

# F45 — Bigger files and paged step data

Status: **Delivered (2026-10-21)**. Slices 1–3 merged in #450, #452 and #453. Slice 4 qualifies the 10 MiB ceiling through actual compiled workflows at 32 attempt slots, nested page loops, exact native HTTP uploads, private container disk, maximum browser uploads, retention, isolation, purge and matched backup/restore. Reproducible worker probes are in `apps/worker/test/runs/files/`; browser resource qualification uses `F45_RELEASE_QUALIFICATION=true`. The release PR records measured evidence and its CI gate. Inline JSON, checkpoint, ordinary collection/loop, capacity and worker memory limits remain unchanged; file references remain ineligible for pins.

## Current code and problem

F04's checked worker file reader and HTTP request body stop at 1 MiB. The artifact store already streams objects, defaults to 10 MiB and has a separately configurable ceiling; the worker writer already spools up to 10 MiB. These are different limits, not permission for every consumer to accept 5 GiB. `apps/web/src/features/artifacts/model/upload.ts` buffers at most 1 MiB to hash an upload today.

The SDK whole-invocation envelope is 1 MiB/depth 64/10,000 members, but **retained execution JSON is only 256 KiB**. Checkpoints are also capped at 256 KiB. Lists have 4,998 items. Raising just the SDK limit would fail persistence or inflate checkpoints, pins, browser queries and retries. Keep those bounds.

Worker attempt concurrency defaults to 32. In single-server Compose, `/tmp` is RAM-backed. The existing artifact spool defaults there, so two 10 MiB scratch files per active attempt could consume about 640 MiB before heap and other work. That is incompatible with treating temporary files as free disk space; the ECS worker health ceiling also defaults to 768 MiB RSS. No large-file release before resource qualification.

## Recommended product behavior

Separate file bytes from mapped JSON, as [n8n's binary-data guidance](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/handle-binary-data.md) does. Make batches explicit, as [Loop Over Items](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/) does. Do not turn every mapping into an implicit remote read.

1. **Files:** accept up to **10 MiB**, further limited by the configured artifact-store ceiling. Raw and multipart HTTP bodies get the same 10 MiB total ceiling, including text, headers and framing: a full-size file cannot fit in multipart. Ordinary inline HTTP bodies and JSON inputs keep their current limits. Show human units and split-file advice.
2. **Large structured data:** add an explicit **Output pages** option to Read file, and **Save items as pages** to HTTP pagination. Return `{pages: [<existing F04 file references>], itemCount, pageCount}`. Each page is an ordinary UTF-8 JSON-array file, ordered and immutable. The descriptor is ordinary bounded JSON, not a new stored-value kind, lazy array, manifest table or executable/checkpoint format. Existing modes and output shapes remain unchanged by default.
3. **Use pages:** For Each over `pages` → Read file (JSON, ordinary mode) → existing Filter/Summarize/For Each steps. No automatic loading of all pages, no new loop semantics, and no increase to loop or collection limits. The user chooses how to combine summaries. An individual record/object/string too large for an ordinary page must be split or remain an opaque file; arbitrary giant JSONata values are outside this slice.
4. **Create file from pages:** an explicit input mode takes the ordered page references and writes one JSON array or CSV file incrementally. CSV keeps one header, configured column order and existing quoting/formula protection; require explicit columns in this mode rather than scanning every row twice to discover columns. Plain text keeps its current bounded string input. No silent concatenation of unrelated JSON documents.
5. **HTTP paging:** retain GET-only safety, page order, max pages, next/cursor handling, Retry-After and completion metadata. Each provider response still has a bounded parsing window; this option lifts the aggregate, not the maximum provider page. Oversized provider pages fail with advice to lower page size. A terminal error never returns a misleading successful partial bundle.
6. **Browser:** upload/download actual files through existing authorized artifact routes and presigned operations, never large JSON endpoint bodies or TanStack cache entries. Keep SHA-256 and finalization. At this first 10 MiB ceiling, retain one explicitly bounded, short-lived browser `File.arrayBuffer()` for WebCrypto hashing, wipe the owned buffer and release it before upload; do not claim it streams. [WebCrypto digest does not accept a stream](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest). Measure responsiveness and peak memory at the new maximum before release. No new hashing library/runtime just to avoid this small fixed buffer; incremental browser hashing is later if that measurement fails or limits grow.

## Proposed bounds (acceptance targets, not measured claims)

| Resource | First-release ceiling |
| --- | --- |
| One file; total encoded outbound HTTP body | 10 MiB, or lower configured storage limit |
| Logical paged result | 10 MiB encoded page bytes, 100,000 records, 256 pages; first reached wins |
| One page | 64 KiB encoded JSON including array framing; 1,000 records; depth 48; 4,000 members |
| One record | Must fit all page and retained-value text/Unicode rules |
| Descriptor | Existing 256 KiB retained JSON limits, checked before accepting more pages |
| Streaming buffers | 64 KiB chunks with backpressure; bounded parser state and one page under construction |
| Scratch | At most 20 MiB per attempt across all live spools; 1 GiB aggregate owned-scratch ceiling per worker, with additional filesystem headroom |
| Time | Existing attempt/run deadline; abort after 60 seconds without byte progress, whichever comes first |

Keep ordinary capacity unchanged. Record measured RSS, heap/external memory, disk usage, checkpoint size, database writes and scheduling latency. If a target is unsafe, reduce it and return to review; never compensate by raising worker memory, queue concurrency, run slots or checkpoint bounds silently. CSV → JSON expansion can hit the logical-output cap before file size; errors explain which limit was reached.

## Safety and ownership

- **Verify before use.** Extend the existing scoped worker artifact capability with a private verified-spool handle: check workspace/read permission, purpose/retention and the full descriptor; stream to owned scratch, verify declared length and SHA-256 through EOF, then allow parsing or outbound dispatch. The store's streaming integrity check completes at EOF, so forwarding unchecked chunks directly to an external HTTP service is forbidden. Handles are attempt-local, never paths accepted from a workflow or persisted in JSON. Close/unlink in `finally` on success, error and cancellation.
- **Scratch is a reviewed deployment adjustment.** Configure a dedicated private disk-backed directory/ephemeral volume per worker container (0700 directory, 0600 files), separate from RAM `/tmp`; no shared directory between live workers. Single-server uses a local Docker volume and ECS task ephemeral storage. This adds storage configuration, not another service, account or durable store. Startup removes only owned abandoned spools before starting that container's consumers. Reserve bytes before writes against both the attempt and worker ceilings; use actual free-space checks and content-free errors. Cleanup failure keeps its bytes charged, so repeated failures cannot grow scratch without bound; refuse new spools when that budget is exhausted. Startup cleanup must succeed before consumers start. Backups exclude scratch. A crash loses scratch safely because retries read the immutable stored file again.
- **One runtime owner.** `apps/worker/src/attempts/artifacts/` owns verification, scratch, reopening, byte/progress limits and cleanup; SDK root owns browser-safe reference/size policies, `/server` owns the capability interface. `packages/artifact-store` retains transport/checksum responsibilities. Short metadata transactions only; never hold a database connection while waiting for storage, a parser or an HTTP peer.
- **One HTTP transport.** Extend the current secure transport body contract to a length-known, reopenable verified byte source. Preserve SSRF/DNS/redirect checks, generated multipart boundary, credential dispatch checks, cancellation and ADR 007/F09 unknown-outcome rules. A redirect reopens the same verified source only when today's method/origin rules permit it. GET/HEAD still reject bodies. No second fetch client or HTTP effects policy.
- **Bound parsers before assembly.** Reuse pinned `csv-parse` in streaming mode, with current quoting, BOM, conversion, header and column rules. For JSON, qualify pinned `@streamparser/json` as a candidate using its [documented tokenizer/value callbacks](https://github.com/juanjoDiaz/streamparser-json): feed bounded chunks, enforce token/string/depth/member/record limits before materializing a record, and discard emitted records. Its buffer-size options are optimizations, not safety limits. Only a top-level array is pageable initially. No custom JSON grammar or trusting a parser's stream label as a memory guarantee. Slice 1 must prove hostile-input bounds before selecting the dependency; otherwise return to owner review, with no unbounded fallback.
- **Retention and redaction:** keep original uploads, page files and generated files on existing F04 reference acceptance, workspace isolation, storage accounting and expiry. Count all physical files, not only logical bytes. Drafts, input cases, pins, versions and runs retain referenced pages through the existing recursive reference collector. Test/preview lifetimes and ordinary run lifetimes remain unchanged. Finalize all pages and validate the descriptor before publishing it as a successful output; abandoned partial pages expire through the existing artifact lifecycle. Preserve the transport's existing credential redaction, including secrets split across chunks, before storing HTTP response pages/files. No contents in errors/logs, raw signed URLs, browser parser, malware-scanning claim or new recovery exception.
- **Editor and docs:** explain files versus pages, show counts/bytes and normal authorized download actions, offer the two-loop example, and keep metadata-only previews. Pins, replay and recovery keep their current artifact restrictions. Export/import/promotion never copy file bytes or grant cross-workspace access by copying a descriptor.

## Implementation slices after owner approval

1. **Qualify and record:** benchmark current 1 MiB behavior and the proposed maxima with disposable storage/workspace data; verify parser allocation bounds and private disk lifecycle. Amend ADR 075 with the approved streaming/size decision and record evidence here. No new CI job. Move reusable code separately if necessary.
2. **Runtime and files:** implement the checked spool interface, disk configuration/cleanup, larger uploads and raw/multipart file transport. Add integration tests using a local receiver and existing artifact store; preserve current small-file behavior.
3. **Explicit pages:** Read file paging, Create file from pages and HTTP paginated-result files; use ordinary artifacts and existing persistence/ref retention. Add complete editor modes with normal mappings and guides; update F04/F08/F32/F34/F38 claims only where changed.
4. **Release qualification:** full project checks, pre-push, worker/database integration, mocked/live browser and phone/pane/desktop in both themes. Run the resource/fairness tests below, publish measured evidence, then green CI/rebase-merge one coherent PR per slice.

## Required evidence

- Exact boundary and one-byte-over tests for input, encoded multipart, pages, aggregate result and descriptor; Unicode/UTF-8 boundaries, multiline CSV, large tokens/deep JSON, malformed final bytes and oversized single records. Stable order/counts with empty and maximum results. No partial success on parse/storage/quota failure.
- Length/SHA corruption at the very last chunk must cause **zero outbound dispatches**. Foreign workspace, expired, stale fingerprint, revoked access and failed finalization remain refused. Credential values split at every chunk boundary stay redacted.
- Slow/stalled storage and HTTP peers, redirects, disconnects and cancellation release iterators, handles, scratch and pooled connections. Existing retries/unknown outcomes remain unchanged. No generated files or scratch paths leak into logs.
- At maximum default worker attempt concurrency, mix large raw/multipart transfers, paging and ordinary short steps. Record RSS/heap/external buffers and disk separately (including container tmpfs), deadline/queue latency, database write volume and checkpoint size. Demonstrate bounded growth and responsive short work without raising capacity.
- Upload → page CSV → outer/inner loops → summarize → Create file from pages → exact local multipart receiver; real JSON paginated HTTP source → pages → same consumers. Preview/test/pin/history, expiry, workspace purge and backup/restore continue to authorize and retain every referenced page correctly.

## Slice 1 evidence (2026-10-21)

Qualification uses disposable PostgreSQL/artifact data and dedicated private local
scratch. These are component measurements on the development machine, not a
whole-worker release claim. The 10 MiB candidate passes this gate; public limits
remain unchanged until the next slices.

| Probe | Baseline | Candidate maximum |
| --- | --- | --- |
| Streaming JSON records | 10,000 records / 968,889 bytes | 100,000 records / 9,788,889 bytes |
| Parser peak RSS / heap / external | 80.9 / 18.4 / 1.74 MiB | 81.9 / 19.0 / 1.78 MiB |
| 32 concurrent disk spools | 32 × 1 MiB | 32 × 10 MiB |
| Scratch peak RSS / heap / external | 100.1 / 11.4 / 32.4 MiB | 110.4 / 10.6 / 47.0 MiB |
| Scratch bytes, held until release | 32 MiB | 320 MiB |
| Spool elapsed / event-loop p99 | 48.8 / 10.3 ms | 232.6 / 10.9 ms |
| PostgreSQL artifact metadata row | 312 bytes for 1 MiB file | 312 bytes for 10 MiB file |

- Both allocation probes run in child processes with a 64 MiB heap ceiling.
  Parser qualification includes unfinished exponents, long strings/keys, deep
  nesting, excessive members, exact/over byte limits, split UTF-8 and escapes,
  malformed EOF, cancellation and paused consumers. A separate raw-token budget
  bounds unfinished numeric tokens even where the library emits no useful
  partial callback. No fallback parser is selected.
- Private scratch proves 0700/0600 permissions, hash through EOF, exact reopen,
  cancellation, disk reservations at the 20 MiB/attempt and 1 GiB/worker bounds,
  reader closure, startup cleanup, and refusal after cleanup failure. A failed
  cleanup retains its reservation and refuses further work until clean startup.
- Real artifact upload/finalize/download checks exact bytes and metadata at
  1 MiB and 10 MiB; original public readers still refuse the larger file. No
  file contents enter PostgreSQL. Artifact and disposable database cleanup pass.
- Remaining in slice 4: mixed actual workflow transfers/pages at default
  concurrency, full checkpoint/WAL/write-volume and scheduling evidence,
  browser hashing responsiveness, retention/purge/restore and full journeys.
  The scratch event-loop probe does not replace those acceptance tests.

## Later

Files above 10 MiB, unbounded provider pages, arbitrary huge mapped values, lazy transparent arrays, parallel chunk uploads, compression/archives, spreadsheets, public file browser, malware scanning, email attachments, integrations F21 and AI F22. No implementation begins until owner review of this plan.

## Heap qualification follow-up (2026-10-23)

Single-server worker Node options now cap V8 old space at 384 MiB: half the
unchanged 768 MiB RSS safety ceiling, leaving room for buffers, young space and
native memory. Attempt concurrency remains 32, workspace slots remain 5, scratch
remains 1 GiB, and checkpoints remain 256 KiB. No file/data limit increases.

The existing whole-worker release test was run before and after the heap option:

| Platform and heap | 1 MiB batch peak RSS | 10 MiB / 100,000-record batch peak RSS | Result |
| --- | ---: | ---: | --- |
| Darwin ARM64, Node 24.15.0, default | 823,902,208 bytes | Not reached | Fails the unchanged 805,306,368-byte assertion, despite 34 completed runs |
| Darwin ARM64, Node 24.15.0, 384 MiB | 563,560,448 bytes | 657,752,064 bytes | Both batches complete 34/34; no resource drain |
| Linux ARM64, Node 24.22.0, default | 490,405,888 bytes | 539,938,816 bytes | Both batches complete 34/34; the default-heap failure does **not** reproduce here |
| Linux ARM64, Node 24.22.0, 384 MiB | 461,201,408 bytes | 494,862,336 bytes | Both batches complete 34/34; no resource drain |

Linux used the already-cached production runtime image, with a read-only root
filesystem and private disk scratch; no image download. The temporary test
harness plus worker container had a 2 GiB cgroup bound and two CPUs within the
existing Docker 4 GB cap. Worker RSS is measured separately and its safety
ceiling stayed 768 MiB. The runtime image ID and raw reports accompany the audit
fix evidence. A compiler-only setup OOM was resolved before qualification by
giving TypeScript 1,536 MiB; this was not a worker result or runtime heap change.

At the Linux 10 MiB control: 32 maximum active attempts, five maximum occupied
workspace slots, 1,434-byte maximum checkpoint, 263,013,319 scratch bytes, zero
failed attempts and no resource drain. The two short runs finished within 8,672
ms; 10,573,888 WAL bytes were observed. Timings include cold/warm host variation
and are not a claimed speedup. The explicit heap budget bounds GC headroom
across runtimes; the Linux baseline already met the original safety gate.

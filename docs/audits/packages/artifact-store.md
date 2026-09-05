# `@pertexo/artifact-store` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 10 source files and all 3,214 physical source
  lines.
- **Test scope:** all 11 tracked test/fixture files and all 3,543 physical
  lines, the API/worker/retention/recovery/lifecycle consumers, package and root
  scripts, Compose services, CI integration gates, release evidence, and the
  external-platform boundary.
- **Architecture sources:** the authoritative backend plan, ADRs 013, 015, 028,
  and 030, and the regional-recovery, production-data-policy, release-security,
  and external-platform runbooks.
- **Audit status:** granularly certified for the pinned tree.
- **Implementation status (2026-09-05):** ten repository-actionable findings
  are implemented, ART-005 is partially complete while the newly
  selected source-hashed branch cohort is reviewed, ART-008 still requires
  live AWS/regional evidence, and ART-011 remains a continuous deployment-shape
  safeguard rather than an active defect.

## Remediation reconciliation

| Finding | Final status | Current evidence |
| --- | --- | --- |
| ART-001 | Fixed in code; live geography remains ART-008 | `3289414`; readiness uses the provider-reported bucket region and rejects configured drift before dual-region comparison. |
| ART-002 | Fixed locally; production latency evidence remains external | `b45d960`; bounded readiness attestations expire/invalidate, append request counts drop from repeated full proofs, and reconciliation GET concurrency is capped at eight while preserving chain order. |
| ART-003 | Fixed | `dcc96b1`; both dual coordinators emit one bounded safety observation for unavailable, partial, or divergent regional outcomes. |
| ART-004 | Fixed | `e208935`; owned close always attempts both stores, aggregates failures, and remains idempotent. |
| ART-005 | Partially fixed; continuous gate | `19ae523`, `0f1c8a9`; all package source is thresholded and now enters the root source-hashed risk report. The newly exposed review backlog remains actionable. |
| ART-006 | Fixed | `87827a8`, `8c85107`; presigning shares the caller/timeout signal, ignores late settlement, preserves exact cancellation, and recovers on the next call. |
| ART-007 | Fixed | `f522666`; one command/output map drives typed sends, with compile-time mismatch tests and runtime provider validation retained. |
| ART-008 | External production evidence required | The three AWS-only tests, Frankfurt/Ireland identity, version lifecycle, one-sided outage, restore, and measured RPO/RTO drills still require deployed resources and credentials. |
| ART-009 | Fixed | `10b9561`; endpoint, bucket, and regional configuration primitives have one package-private owner with parity tests; distinct artifact/ledger policy remains explicit. |
| ART-010 | Fixed | `db66903`; purge validates exact verbose delete acknowledgements and rejects missing, duplicate, malformed, or foreign results. |
| ART-011 | Continuous safeguard; intentionally retained | The supported unbundled Node deployment and actual AWS command constructors are smoke-tested; subpaths/explicit tags are deferred until a real bundling or lightweight-consumer requirement appears. |
| ART-012 | Fixed | `87827a8`; PUT and post-upload HEAD share one operation signal/deadline and exact abort reason, with timeout and listener-cleanup regressions. |
| ART-013 | Fixed | `e208935`; injected clients are borrowed by default, owned/internally-created clients close once, and close failures remain visible. |

This package is a necessary, high-Leverage infrastructure Module. Its public
Interface hides immutable artifact upload/download, streamed checksum and size
verification, bounded object-version purge, independently retained control
records, hash-chain reconciliation, dual-region coordination, AWS request
telemetry, and resource ownership. These are legitimate responsibilities for a
workflow platform with artifact-backed values and restore-before-serve deletion
enforcement. The package is not useless abstraction and should not be collapsed
into API or database code.

The implementation is generally careful. It derives tenant keys internally,
uses conditional creation, keeps bodies streamed, destroys abandoned streams,
combines caller cancellation with timeouts, verifies provider and application
checksums, bounds every list/body operation, treats ambiguous writes as retained
rather than deleting possible successes, and makes cross-region disagreements
fail closed. The control record schema is a real command-state union, the bytes
are canonical and hash chained, and exact retry is the only repair path for a
one-sided command tail.

The strongest remaining defect is that artifact-store readiness does not prove
the region it reports. It executes only `HeadBucket`, then returns the configured
region. The dual-region guard therefore compares two configuration strings, not
two provider facts. The local “dual-region” integration deliberately uses one
S3Mock endpoint with two configured regions and passes, demonstrating that this
Interface cannot establish the regional property its result implies. This does
not invalidate checksum replication, but it is insufficient evidence for ADR
015's Frankfurt/Ireland promise.

The other material concern is efficiency at the control-ledger seam. One first
record append through the production-shaped dual facade issued 28 S3 operations
in a deterministic memory-client probe. The facade checks both regions, reads
both targets, and then each regional append repeats all six bucket-control
checks. Reconciliation repeats readiness again inside each region and performs
record GETs serially. Strong startup checks are correct; repeating the full
policy/Object-Lock/lifecycle proof in nested calls is unnecessarily shallow as
an operational Interface and needs measured redesign without weakening failure
closure.

## Evidence collected

The review used complete source/test reading, public-export and internal-callable
inventory, repository-wide consumer tracing, plan/ADR/runbook comparison,
build/typecheck/lint evidence, package tests, V8 coverage, the live local
S3Mock/dual-MinIO integration suite, a request-count probe, and a cold-import
probe.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/artifact-store test` | 8 files and 138 tests passed |
| Package typecheck and build | Passed in the repository pre-push gate |
| Repository ESLint | Passed with the repository's 8 GiB Node heap |
| Ad hoc package V8 coverage | 88.38% statements, 82.77% branches, 92.06% functions, 90.45% lines |
| Local real-service package suite | 2 files passed; 5 MinIO/S3Mock assertions passed and 3 AWS-only assertions skipped |
| CI cohort contract | Requires exactly 5 executed and 3 skipped artifact-store integration assertions |
| Dual first-record append request probe | 14 requests per region, 28 total |
| Built root-module cold import probe | about 53 ms and 16.2 MiB heap growth on this host |
| Source duplication gate | Records the configuration-schema clone between `config.ts` and `control-ledger-config.ts` |
| Complexity ratchet | Accepts `store.ts` and `control-ledger.ts` as reviewed large-file baselines |

### Granular certification record

This certification is not a hotspot sample. The review read the complete
contents of every one of the package's 26 tracked files: 10 production files
(3,214 lines), 11 test/fixture files (3,543 lines), `package.json`, both
TypeScript configurations, and both Vitest configurations (73 lines). It
accounted for every exported declaration, class method, internal helper,
factory, schema, error path, resource-lifecycle path, test, fake, and package
script. The direct lifecycle-command, recovery, retention, and worker consumer
seams were retraced after the package reading.

The source tree is byte-for-byte unchanged from the pinned implementation
commit. Fresh package-local evidence produced 8 passing files and 138 passing
tests, a passing build and typecheck, a clean direct ESLint run, and V8 coverage
of 88.38% statements, 82.77% branches, 92.06% functions, and 90.45% lines. The
existing real-service and CI evidence below remains applicable because the
implementation did not change. ART-001 through ART-013 are the complete
findings from this file-level certification, not a top-N selection.

The timing and heap values are development-host diagnostics, not production
SLOs. The request count is structural: it was recorded through the real
coordination and regional ledger implementations with deterministic S3 clients.
AWS's authoritative `HeadBucket` contract exposes `x-amz-bucket-region`, so the
provider fact needed by ART-001 is available rather than hypothetical. Its
`DeleteObjects` contract also returns one `Deleted` or `Error` result per
requested object in verbose mode, supporting ART-010's acknowledgement check:
[HeadBucket](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html),
[DeleteObjects](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html).

## Architecture, ownership, and dependency direction

### Public Interface and exports

The root export is server-only and publishes four cohesive capabilities:

- artifact configuration, `ArtifactStore`, direct-upload and download value
  types, integrity/not-found/closed errors, and `createArtifactStore`;
- dual-region artifact coordination, readiness, replica verification,
  partial-replication error, and `createDualRegionArtifactStore`;
- control-ledger configuration, command/read/reconciliation types, the four
  ledger errors, and `createControlLedger`;
- dual-region ledger coordination, readiness, partial-replication error, and
  `createDualRegionControlLedger`;
- bounded object-store metric vocabulary, observer types, `ObservedS3Client`,
  and observer factories.

`WorkspaceObjectPurgeStore` is deliberately narrower than `ArtifactStore` and
lets maintenance receive destructive capability without expanding serving
roles. That is a good authority Seam. `S3ClientLike`, `ControlLedgerS3Client`,
and `PutObjectPresigner` are exported from their files but not the package root;
they function as package-local test seams rather than general platform APIs.

No browser, domain, NestJS, BullMQ, or database dependency leaks inward. The
package depends only on Node, Zod, OpenTelemetry, and AWS S3/presigning. Apps and
database lifecycle coordinators depend on its Interfaces; the storage package
does not depend back on them. This is the right direction.

### Depth, cohesion, and proposed internal shape

The conceptual Module is deep, but two files mix owners that change for
different reasons:

- `store.ts` combines public values, Zod admission, storage-key/metadata codec,
  stream verification, ordinary object operations, version purge, observation,
  and AWS composition.
- `control-ledger.ts` combines the command grammar, canonical byte/hash codec,
  IAM policy interpretation, bucket readiness, object I/O, append/read, bounded
  reconciliation, observation, and composition.

Their current long procedures are not automatically bad. Streaming integrity,
readiness proof, and reconciliation are sequential protocols whose ordering is
important. Refactor only around the existing ownership seams, preserving a
small public facade:

```text
src/
  artifact-store.ts                 public artifact facade/types/errors
  artifact/config.ts
  artifact/metadata-codec.ts
  artifact/verifying-stream.ts
  artifact/aws-store.ts
  artifact/workspace-version-purge.ts
  artifact/dual-region.ts
  control-ledger.ts                 public ledger facade/types/errors
  ledger/config.ts
  ledger/record-contract.ts
  ledger/canonical-record.ts
  ledger/bucket-policy.ts
  ledger/readiness.ts
  ledger/aws-ledger.ts
  ledger/reconciliation.ts
  ledger/dual-region.ts
  object-store-telemetry.ts
  index.ts
```

These should remain package-internal files, not new public subpaths or generic
utility packages. A split is successful only if it reduces the knowledge needed
to change one policy and preserves protocol tests; line-count reduction alone
is not success.

## Complete production-code review

### `src/server-only.ts`

The import-time Node guard is appropriate for a package containing streams,
crypto, AWS clients, and process configuration. The package also maps its root
to `false` for browser bundlers. The guard is defense in depth; package exports
should remain the primary boundary.

### `src/artifact-metadata.ts`

`artifactMetadataMatches` is a useful single owner for exact identity, length,
media type, and digest equality. It is used by both ordinary and dual-region
stores, passes the deletion test, and should not become a repository-generic
equality helper. It correctly excludes incidental provider fields.

### `src/config.ts`

Artifact configuration validates credential presence, credential-free HTTP(S)
endpoints, S3-compatible bucket syntax, explicit boolean text, a 100–60,000 ms
request timeout, and a maximum object size capped at 5 GiB. Returned objects are
frozen and secrets are not included in readiness output.

Dual parsing requires different access-key IDs, buckets, and configured region
names and equal object limits. Sharing an endpoint remains allowed for local
testing. These are useful configuration checks, but configured region inequality
is not provider-region evidence (ART-001).

The endpoint and bucket schemas are copied into the ledger config and are an
accepted source-duplication baseline. Consolidate them into a small private S3
configuration primitive when either copy next changes (ART-009). Do not expose a
generic environment framework.

### `src/control-ledger-config.ts`

Dedicated variables prevent silent fallback to ordinary artifact credentials.
The primary and recovery credentials, buckets, and regions must differ; both
also reject the ordinary artifact bucket when it is supplied. This correctly
models the independent-principal boundary.

The recovery schema is manually restated instead of projected from one bounded
configuration grammar. That creates naming/default drift risk: artifact recovery
inherits the primary timeout when omitted, while ledger recovery independently
defaults to five seconds. Make this behavior explicit in one projected private
schema and add table-driven parity tests (ART-009).

### `src/store.ts`: contracts, metadata, and keys

The value types are readable and narrowly scoped. UUID workspace/artifact IDs,
bounded media types, lowercase SHA-256, byte counts, upload expiry, and purge
page size are revalidated at runtime. Storage keys are derived solely from
validated identities and cannot be supplied by callers, preventing prefix
escape. User metadata has an exact sorted key set and is cross-checked against
the object content length and content type.

The media-type regex is intentionally permissive and metadata comparison treats
semicolon whitespace as insignificant. If product code later needs standards-
grade media-type parsing, introduce it here rather than distributing parsing
across callers. It is not currently a correctness defect because writers and
readers use the same bounded representation.

Provider outputs are recovered through `as` casts after `send(): unknown`.
Important fields are subsequently validated, but this loses the AWS SDK's
command/result type relationship and makes omissions easy during future changes.
Use a generic command-to-output test Adapter or overloads rather than broad
unknown casts while retaining fake-client injection (ART-007).

### `src/store.ts`: streaming integrity and lifecycle

`VerifyingTransform`, `verifiedBody`, `consume`, and `destroyResponseBody`
correctly keep uploads/downloads streaming, enforce declared and maximum bytes,
hash every byte, propagate source errors, remove abort listeners, and destroy
both sides when abandoned or invalid. Input-integrity errors are distinguished
privately so untrusted caller mistakes do not emit stored-corruption alarms.

One request signal bounds post-header stream consumption, not merely receipt of
headers. Tests explicitly prove timeout, caller abort, abandoned downstream,
upstream error, metadata failure, and checksum corruption. This is strong code.

`put` uses conditional creation, never deletes after an ambiguous failure, and
verifies with a separate HEAD before success. That verification passes parsed
metadata rather than the original request, dropping the caller's signal and
starting a fresh timeout budget after the upload (ART-012).
`validateDirectUpload` prefers a full-object provider checksum and otherwise
consumes a bounded verified GET.
Presigned uploads bind length, media type, conditional create, checksum, and
every identity metadata field.

The presigner Interface receives no abort signal or internal deadline. The
built-in presigner uses static credentials and is normally local, but an
injected or later asynchronous credential signer can hold `beginDirectUpload`
forever; the pre/post abort checks cannot interrupt it. Either make this Seam
explicitly synchronous/local or pass a bounded signal/deadline and test a hung
presigner (ART-006).

`delete` intentionally issues an unversioned delete. On a version-enabled
tenant bucket this creates beyond-serving state while external lifecycle policy
removes noncurrent versions within the accepted 35-day window. Database
retention verifies HEAD absence before dropping metadata. Do not change this to
unbounded version enumeration; workspace purge owns explicit physical version
erasure.

### `src/store.ts`: bounded workspace purge

The purge Interface lists at most 500 versions/delete markers from the first
page on every invocation, validates prefix and version identity, rejects
duplicates and malformed/truncated-empty responses, explicitly deletes versions,
and reports completion only after a fresh empty listing. Restarting at the first
page avoids persisting continuation tokens invalidated by deletion and is a
sound crash-recovery design.

It checks provider `Errors` but does not validate the `Deleted` result set and
reports the requested count as deleted. A compatible service that omits or
misreports individual successes can therefore inflate progress metrics. The
next page prevents premature final completion if objects remain, so this is not
a deletion-bypass defect; validate exact acknowledgements or rename the field to
attempted count (ART-010).

### `src/store.ts`: observation and construction

`ObservedArtifactStore` reports stored-integrity failures without letting
observer exceptions alter behavior. Stream errors are observed after the method
returns. `AwsArtifactStore.close` always destroys its client, including an
injected client. Unlike the ledger and dual-region factories, the single-store
factory has no ownership option, so an injected shared client is implicitly
owned (ART-013).

The root facade eagerly loads AWS S3, presigning, ledger, and telemetry modules.
The measured built import cost is nontrivial, but current runtime consumers load
the factories at process composition and need most of that code. Add narrow
subpaths only if a real consumer needs configuration/types at runtime without
AWS construction; do not optimize the probe in isolation (ART-011).

### `src/dual-region-artifact-store.ts`

The coordinator accepts either two configs or two complete stores, rejects mixed
inputs, and requires explicit ownership for injected resources. Primary-first
stream replication avoids buffering; exact replay heals one-sided writes; both
replicas are revalidated before success. Reads intentionally use the active
primary—the recovery application verifies/reverses regional composition before
serve rather than performing opportunistic per-request failover.

`checkReadiness` correctly waits for both results and preserves cancellation,
but its regional proof is only as strong as the underlying readiness result.
Because that result echoes configuration, same-region resources pass when their
strings differ (ART-001).

`close` stops after the first thrown close, potentially leaking the recovery
store. The ledger coordinator already demonstrates the right pattern: attempt
both closes and throw one `AggregateError` after cleanup (ART-004).

Delete/purge partial failures intentionally retain progress for retry. Error
objects discard which region and cause failed, and coordinator-created replica,
readiness, and purge disagreements do not emit a safety-violation metric. This
makes the most important cross-region failures harder to operate (ART-003).

### `src/control-ledger.ts`: record contract and canonical codec

The strict discriminated union gives legal authority only to hold placement and
release, bounds all strings, requires offset timestamps and safe sequences, and
uses a zero-hash genesis. Append input omits generated schema/hash fields.
Canonical JSON sorts keys, excludes only undefined object fields, and feeds both
record hashing and exact byte comparison. All parsed record shapes contain only
schema-admitted finite scalars, so the helper's broader unsupported-value edges
are not reachable through the ledger.

Reads bound content type, declared and observed size, body streaming, optional
provider checksum, canonical bytes, workspace/sequence identity, genesis, and
record hash. Missing-key translation is deliberately limited to the S3 request,
not body-stream failures. These checks are cohesive and well tested.

### `src/control-ledger.ts`: bucket policy and readiness

The policy interpreter verifies unconditional denial of object deletion,
version deletion, replicated deletion/object mutation, and denial of PUT without
`If-None-Match` over a resource covering the ledger prefix. It handles string or
array actions/resources and bounded `*` action matching. Malformed or unfamiliar
policy shapes fail closed.

That conservative parser recognizes only `Principal: "*"` and one exact `Null`
condition form. Equivalent AWS policy encodings may false-fail. Keep a repository-
owned canonical platform policy and test its exported snapshot rather than
trying to implement all IAM semantics locally. Any parser expansion needs AWS
policy-simulator or live-IAM evidence (ART-008).

Readiness proves bucket reachability, service-reported location, enabled
versioning/Object Lock, compliance retention, absence of lifecycle rules, and
the policy protections under one aggregate abort budget. This is appropriately
strict for startup and recovery.

### `src/control-ledger.ts`: append, read, and reconcile

Append proves readiness, validates predecessor existence/hash, computes exact
canonical bytes, uses conditional PUT with compliance retention, validates an
optional write checksum, returns exact replay on ambiguous conditional conflict,
and reports stable conflict otherwise. It never exposes deletion.

Reconciliation validates the PostgreSQL projection anchor, requests one bounded
lookahead record, validates consecutive keys and page contract, reads each
record, and proves the hash chain. Sequential reads make reasoning simple and
memory bounded. They also make the recovery gate latency proportional to record
count and region round trips.

Every append/reconcile performs the full bucket-control proof. When called
through the dual coordinator, that proof is repeated before entering each
regional operation. A first append performs 28 S3 requests; a full 100-record
dual page structurally requires hundreds of calls. Separate an explicit fresh
startup/readiness attestation from bounded recurring health, reuse one attested
operation context through nested calls, and batch bounded independent GETs only
after measuring provider limits. Preserve fail-closed expiry and invalidation
(ART-002).

### `src/dual-region-control-ledger.ts`

The coordinator has careful outcome classification. Exact dual success returns
one record; one success plus conflict is divergence; two conflicts preserve a
stable conflict; ambiguous one-sided success becomes partial replication; and
exact retry alone fills the absent side. Pre-read prevents repairing a different
command. Cancellation waits for both settlements, avoiding hidden in-flight
writes.

Reads require exact equality. Reconciliation fails on disagreement except for
one exact command-ID tail used only to expose the common prefix during that
command's repair. It does not silently heal ordinary restore divergence. Owned
close attempts both resources and aggregates errors. These semantics align with
ADR 013 and the runbook.

`exactEqual` is a small internal value comparator, but it partly duplicates the
canonical-record equivalence idea and accepts non-plain objects outside the
current schema. Keep it private and either compare canonical admitted records or
constrain its input; do not export a generic deep-equality utility (ART-009).

Coordinator-originated append/read/reconcile disagreement is not wrapped by the
regional observers, so it can fail without a safety-violation counter. Only
region-isolation failure is explicitly observed. Add bounded dual-coordination
outcome metrics and preserve causes in internal logs without tenant data or
credentials (ART-003).

### `src/object-store-telemetry.ts`

The vocabulary is bounded and contains no tenant/resource IDs. `ObservedS3Client`
maps stable command class names to operations, classifies cancellation, timeout,
not-found, precondition, and service errors, measures duration, and never lets
telemetry change storage behavior. Presigning receives the same treatment.

Constructor-name dispatch is acceptable in the current unbundled Node build but
would silently become `unknown` under minification or SDK wrapper commands. A
typed explicit operation argument would be more robust if the deployment build
changes (ART-011). Current request-level metrics do not replace missing
coordination safety metrics (ART-003).

### `src/index.ts`

Exports are explicit, type exports are separated, and `.js` specifiers are
correct for NodeNext ESM. `ArtifactInputIntegrityError` and AWS test seams remain
private. The single root is broad but coherent for process composition. Avoid
wildcard exports; add purpose-specific subpaths only when consumer evidence
justifies them.

## Tests, coverage, and CI

### Test-file assessment

- `config.test.ts` and `control-ledger-config.test.ts` prove defaults, strict
  parsing, immutable results, dedicated credentials/buckets, and regional
  separation. Add parity tables for their shared primitives and explicit
  recovery-default decisions.
- `store.test.ts` is a valuable behavioral suite, not test-for-test's-sake. It
  covers immutable and ambiguous PUTs, direct signing, provider/fallback
  checksums, invalid/abandoned/aborted/timed-out streams, corrupt downloads,
  idempotent deletion, bounded version purge, partial deletion, readiness, and
  close.
- `dual-region-artifact-store.test.ts` proves basic replication, exact retry,
  direct-upload replication, count disagreement, readiness shape, and ownership.
  At 64.63% statement/65.67% branch coverage it misses many high-value regional
  failure permutations, cancellation, corrupted-existing replica, mixed
  config/store rejection, delete partials, verify failure, and close failure.
- `control-ledger.test.ts` and `control-ledger-part-2.test.ts` prove canonical
  bytes/hashes, schemas, predecessor chains, replay/conflict races, checksum and
  body failures, bounded listing, anchor/high-water behavior, all bucket controls,
  cancellation/timeouts, and ownership. The “part 2” name is an organizational
  smell; split by `readiness-policy`, `record-io`, and `reconciliation` behavior.
- `dual-region-control-ledger.test.ts` is strong fault-injection evidence for
  outcome classification, one-sided exact repair, cancellation, reads,
  reconciliation, ownership, and close aggregation. Add request-budget and
  coordinator-observation assertions.
- `object-store-telemetry.test.ts` proves bounded dimensions, error classes,
  presigning, safety events, and observer isolation.
- `store.integration.test.ts` proves S3-compatible bytes, scope isolation,
  delete, dual writes, signed headers, immutable duplicate rejection, and
  checksum validation against S3Mock.
- `control-ledger.integration.test.ts` accurately separates AWS and MinIO. CI
  proves MinIO's conditional PUT and immutable delete controls plus the required
  fail-closed incompatibility. The complete successful policy/readiness/dual
  append path is AWS-only and skipped locally and in CI.
- `test/support/control-ledger.fixture.ts` is a focused deterministic S3 fake
  with injectable service, checksum, listing, stream, and timeout failures. It
  models only the subset claimed and should remain package-local.

### Coverage interpretation

138 unit tests pass, but aggregate coverage is not a complete safety claim.
Branch coverage is 82.77%; dual artifact coordination is the weakest production
file at 65.67% branches. The root risk-coverage manifest selects other critical
files and reports 116 reviewed uncovered branches, but it does not select this
package. Add a package-owned threshold and a reviewed branch manifest for
regional result matrices, stream cleanup, policy readiness, and ownership. Do
not chase harmless default-argument instrumentation at the expense of those
risks (ART-005).

### CI and real-service truth

The core job runs the 138 non-integration tests. The integration job starts
S3Mock and two independent MinIO processes, bootstraps the ledgers, runs the two
integration files, and validates exactly five executed/three skipped tests.
This prevents accidental all-skipped green runs and is good CI design.

CI cannot prove AWS IAM condition enforcement, Object Lock semantics, physical
Frankfurt/Ireland isolation, live version erasure, cross-region durability, or
RPO/RTO. The repository correctly records these as external release gates.
Production evidence must execute the three AWS-only assertions plus regional
artifact location/checksum, version lifecycle, one-sided failure, restore, and
measured recovery drills (ART-008).

## Plan and ADR compliance

| Requirement | Assessment |
| --- | --- |
| Direct bounded upload and finalize-time size/checksum/type/scope verification | Satisfied |
| Synchronous checksum-validated writes to both artifact regions before finalization | Satisfied in code and local service behavior |
| Bounded, restart-safe explicit object-version workspace purge | Satisfied in code; live versioned-provider proof remains open |
| Dedicated immutable control ledger outside tenant prefixes | Satisfied in code |
| Conditional append, compliance retention, ordered hash chain, exact retry | Satisfied in code |
| Dual-ledger exact agreement before projection/serve/destruction | Satisfied at the package Interface; consumers reviewed separately |
| Frankfurt/Ireland artifact-region proof | Not satisfied by artifact readiness (ART-001) and externally unverified (ART-008) |
| Five-minute object-storage RPO and 24-hour RTO | Architecture supports it; production measurement remains open |
| Bounded cancellation, failure closure, and no secret/tenant telemetry | Partially satisfied; post-PUT verification drops caller cancellation (ART-012) |
| Full startup compatibility separated from lightweight recurring health | Not cleanly satisfied for nested ledger operations (ART-002) |

The plan is not contradicted by the package boundary. The implementation goes
beyond the early plan in ways required by accepted ADRs: synchronous dual
writes, control-ledger authority, explicit version purge, and recovery
reconciliation. The plan remains authoritative; the audit identifies places
where the code or evidence has not yet fully delivered its later ADR promises.

## Findings

### ART-001 — Artifact readiness reports, but does not verify, region isolation

- **Severity:** P1
- **Classification:** Confirmed defect
- **Status:** Fixed in code; live geography proof remains under ART-008.
- **Evidence:** `AwsArtifactStore.checkReadiness` sends only `HeadBucket` and
  returns `config.region`; the dual guard compares those returned strings. The
  passing local integration uses one endpoint for both configured regions.
- **Impact:** misconfigured same-region resources can satisfy a check presented
  as dual-region readiness, weakening ADR 015 recovery assurance.
- **Remediation:** obtain and normalize provider location, bind endpoint/account/
  bucket identity to the deployment manifest, and have dual readiness compare
  provider facts. Keep S3Mock evidence labeled as compatibility, not geography.
- **Verification:** a same-region/different-string fixture must fail; live AWS
  Frankfurt/Ireland buckets must pass with captured non-secret identity.

### ART-002 — Nested ledger operations repeatedly execute full readiness proofs

- **Severity:** P2
- **Classification:** Maintainability improvement
- **Status:** Fixed locally; production-latency evidence remains external.
- **Evidence:** one dual first append issued 28 S3 operations; dual reconciliation
  invokes its own readiness and each regional reconciliation invokes readiness
  again, then reads records serially.
- **Impact:** avoidable latency/request cost can threaten bounded recovery over
  many workspaces and makes command availability depend on repeated policy APIs.
- **Remediation:** define a fresh attestation token/context with bounded TTL and
  invalidation, distinguish full startup proof from recurring health, pass it
  through nested operations, and benchmark bounded GET concurrency.
- **Verification:** request-budget tests, fault/expiry tests, and a representative
  recovery benchmark against production-like latency must pass.

### ART-003 — Dual-region safety failures lack first-class observations

- **Severity:** P2
- **Classification:** Confirmed defect
- **Status:** Fixed.
- **Evidence:** coordinator-created replica/read/purge/reconcile disagreements
  and partial replication are thrown outside the regional observed wrappers;
  only ledger region-isolation explicitly records a coordinator safety event.
- **Impact:** the failures most relevant to recovery can lack a direct bounded
  safety signal and region/cause diagnostic.
- **Remediation:** inject one observer into both coordinators; record bounded
  operation/outcome/failed-role/check dimensions; preserve sanitized causes in
  logs/traces without tenant identifiers.
- **Verification:** exhaust the settled-result matrix and assert exactly one
  coordinator observation while throwing the same public error.

### ART-004 — Dual artifact close can leak its recovery resource

- **Severity:** P2
- **Classification:** Confirmed defect
- **Status:** Fixed.
- **Evidence:** owned close calls primary then recovery without `try`/aggregation;
  a primary close exception prevents recovery close. The ledger equivalent
  already handles both.
- **Impact:** shutdown may leak sockets/resources and obscure the second failure.
- **Remediation:** attempt both closes and throw `AggregateError` afterward.
- **Verification:** unit-test zero, one, and two close failures plus idempotence.

### ART-005 — Risk coverage does not include this critical package

- **Severity:** P2
- **Classification:** Continuous control
- **Status:** Partially fixed; continuous branch review remains actionable.
- **Evidence:** 82.77% package branch coverage; dual artifact coordination is
  65.67%; the root reviewed-uncovered-branch manifest does not select these files.
- **Impact:** cross-region and cleanup regressions can remain green despite broad
  aggregate tests.
- **Remediation:** add targeted package thresholds and durable reviews for truly
  unreachable/provider-only branches; prioritize regional matrices.
- **Verification:** CI fails on a removed regional/cancellation/cleanup assertion
  and reports exact denominators.

### ART-006 — The presigning Seam has no enforceable execution bound

- **Severity:** P2
- **Classification:** Maintainability improvement
- **Status:** Fixed.
- **Evidence:** `PutObjectPresigner` receives no signal; caller abortion is
  checked only before and after awaiting it.
- **Impact:** a future remote credential provider or injected signer can hold an
  upload request and resource indefinitely.
- **Remediation:** declare the signer local-only or add signal/deadline support
  with a bounded race whose late result is ignored safely.
- **Verification:** a hung signer must time out/abort and later calls must work.

### ART-007 — S3 command and result typing is disconnected

- **Severity:** P2
- **Classification:** Maintainability improvement
- **Status:** Fixed.
- **Evidence:** client `send` returns `unknown`; call sites cast output shapes.
- **Impact:** future commands can compile with the wrong result assumption and
  rely on incomplete runtime validation.
- **Remediation:** use overloads or a generic command/output Adapter that fakes
  can implement, retaining runtime checks for provider data.
- **Verification:** type tests reject mismatched command/output use and all fake/
  real-service tests remain green.

### ART-008 — Production AWS and regional behavior remains external evidence

- **Severity:** P2
- **Classification:** Unverified production assumption
- **Status:** External production evidence required.
- **Evidence:** CI intentionally skips three AWS-only assertions; MinIO rejects
  the required missing-`If-None-Match` bucket-policy condition. Versioned tenant
  bucket and Frankfurt/Ireland drills are also recorded open.
- **Impact:** local green status cannot support production immutability, region,
  lifecycle, RPO, or RTO claims.
- **Remediation:** execute the repository's pinned AWS evidence contract and
  release drills; do not weaken code to make MinIO appear equivalent.
- **Verification:** signed evidence satisfies the external-platform schema and
  release gate for the exact immutable image/configuration.

### ART-009 — Configuration and value-policy primitives have begun to duplicate

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Status:** Fixed.
- **Evidence:** endpoint/bucket grammars are cloned; primary/recovery ledger
  schemas are manually restated; `exactEqual` overlaps canonical record equality.
- **Impact:** defaults or accepted values can drift across regions/surfaces.
- **Remediation:** extract only package-private primitives with table-driven
  parity tests; keep artifact and ledger policy distinct where meaning differs.
- **Verification:** the source duplication baseline shrinks and mutation tests
  show intentional differences remain.

### ART-010 — Purge reports requested deletions rather than acknowledged ones

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Status:** Fixed.
- **Evidence:** only `Errors` is inspected; `Deleted` is not matched to the
  requested keys/version IDs; `deletedCount` is always `objects.length`.
- **Impact:** progress telemetry may overstate physical work, although an empty
  follow-up listing still gates completion.
- **Remediation:** validate exact provider acknowledgements or rename/document
  the count as attempted and separately observe confirmed completion.
- **Verification:** malformed, missing, duplicate, and foreign acknowledgements
  receive explicit tests against the chosen contract.

### ART-011 — Broad loading and constructor-name telemetry are deployment-sensitive

- **Severity:** P3
- **Classification:** Continuous control
- **Status:** Continuous safeguard; intentionally retained.
- **Evidence:** root import eagerly loads all AWS/ledger code; the cold probe was
  about 53 ms/16.2 MiB; telemetry derives operation from constructor names.
- **Impact:** a future lightweight consumer or bundling/minification change can
  add avoidable startup cost or collapse operation metrics to `unknown`.
- **Remediation:** preserve the unbundled Node contract; add subpaths or explicit
  operation tags only when deployment/consumer evidence changes.
- **Verification:** built-artifact import and metric-smoke tests protect the
  selected deployment shape.

### ART-012 — Post-upload verification drops caller cancellation and resets its budget

- **Severity:** P2
- **Classification:** Confirmed defect
- **Status:** Fixed.
- **Evidence:** `AwsArtifactStore.put` uses the request signal for `PutObject`,
  parses the request into metadata, then calls `head(metadata)`. Zod strips the
  signal, so HEAD receives only a new internal timeout. A deterministic client
  probe aborted the caller after PUT and observed a later `TimeoutError` rather
  than the exact caller cancellation reason.
- **Impact:** after bytes are accepted, a cancelled request can retain work and
  resources until the second timeout; total PUT-plus-HEAD wall time can also
  exceed the configured per-operation budget.
- **Remediation:** create one operation-scoped signal/deadline for PUT and
  verification, preserve the caller's exact abort reason, and pass the remaining
  budget into an internal HEAD helper instead of opening a new full budget.
- **Verification:** block HEAD after a successful PUT, abort the caller, and
  require prompt rejection with the exact reason. Retain separate timeout,
  successful verification, and listener-cleanup assertions.

### ART-013 — Injected single-store client ownership is implicit and inconsistent

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Status:** Fixed.
- **Evidence:** `createArtifactStore` accepts an injected client, but
  `AwsArtifactStore.close` always destroys it and exposes no `clientOwnership`
  option. `createControlLedger` and the dual-region facades explicitly model
  owned versus borrowed resources.
- **Impact:** a caller can accidentally destroy a shared or wrapped client, and
  resource conventions differ within one package. Current production consumers
  construct the dual-region facades, so this is not presently traced to an
  active production failure.
- **Remediation:** make injected ownership explicit and use the package's
  borrowed-by-default convention, while keeping internally created clients
  owned.
- **Verification:** prove borrowed, owned, internally created, repeated-close,
  and close-failure behavior with focused tests.

## What should remain unchanged

- Keep object storage behind this dedicated server-only Module.
- Keep workspace/object keys derived internally from validated UUIDs.
- Keep streaming verification, explicit byte limits, and source destruction.
- Keep conditional creation and never delete after ambiguous writes.
- Keep direct client upload with checksum-, metadata-, and scope-bound headers.
- Keep ordinary retention deletion separate from explicit workspace version
  purge and external 35-day lifecycle policy.
- Keep the control ledger outside tenant prefixes, immutable, canonical, hash
  chained, and unavailable through a delete Interface.
- Keep dual writes synchronous and fail closed on either-region uncertainty.
- Keep exact-command retry as the only one-sided ledger repair path.
- Keep telemetry low-cardinality and unable to alter storage behavior.
- Keep injected-resource ownership explicit, extending that rule to the
  single-store factory (ART-013).
- Keep MinIO limitations truthful; do not convert compatibility evidence into an
  AWS or regional claim.

## Recommended implementation order

1. make artifact regional readiness truthful and complete AWS evidence
   (ART-001, ART-008).
2. add coordinator safety observations and close all owned resources reliably
   (ART-003, ART-004).
3. redesign and benchmark readiness reuse/reconciliation request budgets without
   weakening failure closure (ART-002).
4. cover the missing regional/failure matrices and enforce risk coverage
   (ART-005).
5. preserve cancellation across post-upload verification and bound presigning
   (ART-012, ART-006).
6. restore command/result type precision and make injected-client ownership
   explicit (ART-007, ART-013).
7. consolidate only proven private duplication and improve purge acknowledgement
   truth (ART-009, ART-010).
8. preserve the current deployment contract and watch broad-import/operation
   dispatch assumptions (ART-011).

After remediation, run format, build, typecheck, lint, package unit/coverage,
S3Mock and dual-MinIO integration, AWS-only policy/Object-Lock/version tests,
regional fault injection, request-budget benchmarks, the full pre-push gate,
and the external release/recovery evidence gates.

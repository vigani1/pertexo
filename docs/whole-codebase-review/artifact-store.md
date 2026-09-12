# Artifact store: complete file-by-file judgment

All 40 inventory files read against J01–J14, including the integration tests,
their fixture setup and all package configuration. Unit suite: 10 files / 287
tests passed. Integration tests were inspected, **not executed**: they mutate
provider buckets, policies, Object Lock configuration and objects. ADRs 013,
015 and 035 constrain the judgments below. No source or test changes made.

## File ledger

Paths are relative to `packages/artifact-store/`.

| File | Judgment | Concrete reason / action |
| --- | --- | --- |
| `packages/artifact-store/src/artifact-download.ts` | KEEP; regression WQ-022 | Canonical identity-only attachment signing and bounded TTL are coherent. Move the late lifecycle import beside other imports when touching this file; no separate cosmetic project. Exercise cancellation during the presigner invocation. |
| `packages/artifact-store/src/artifact-errors.ts` | KEEP | Small stable error taxonomy; input-integrity subtype intentionally excludes client errors from storage-safety alarms. |
| `packages/artifact-store/src/artifact-metadata.ts` | KEEP | Five explicit immutable identity/material comparisons communicate the invariant better than reflective equality. Reuse at WQ-025's missing check. |
| `packages/artifact-store/src/artifact-request-lifecycle.ts` | FIX WQ-022 | Already-created promise is not observed on the pre-aborted path; unknown-value classification can throw from an ignored promise callback. |
| `packages/artifact-store/src/config-primitives.ts` | KEEP | Shared endpoint/bucket/path-style/timeout grammar is an appropriate private common seam. This is not a complete AWS provisioning validator. |
| `packages/artifact-store/src/config.ts` | KEEP | Explicit environment mapping and region/principal/bucket separation. Equal byte limits are currently guaranteed by one source input; remove the redundant final equality guard only as incidental cleanup, not a finding requiring its own change. |
| `packages/artifact-store/src/control-ledger-config.ts` | KEEP | Cross-product artifact/control bucket collision checks are purposeful isolation rules. Primary and recovery maps remain readable despite repeated fields. |
| `packages/artifact-store/src/control-ledger.ts` | FIX WQ-023; shared boundary WQ-024 | Canonical bytes, conditional append, predecessor proof, bounded read and concurrency preserve ledger authority. Share the existing append normalization with the coordinator; protect telemetry classification. Keep ordered readiness checks explicit. |
| `packages/artifact-store/src/control-ledger/bucket-policy.ts` | KEEP | Conservative recognizer of the supported policy shape, not an IAM interpreter. Required deny actions and exact missing-header condition are meaningful branches; do not broaden accepted policy syntax in a cleanup. |
| `packages/artifact-store/src/control-ledger/errors.ts` | KEEP | Named conflict/readiness/integrity/closed cases expose domain meaning with minimal implementation. |
| `packages/artifact-store/src/control-ledger/reconciliation-validation.ts` | KEEP | Dense listing condition has one invariant and one diagnostic; per-key loop independently proves consecutive identities. Preserve short-circuit null narrowing, sequence overflow and continuation checks. |
| `packages/artifact-store/src/control-ledger/record-key.ts` | KEEP | Fixed-width lexical ordering is protocol behavior, not decorative formatting. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | TEST/CONDITIONAL WQ-027 | Explicit partial/divergent outcomes and independent close attempts are valuable. Pin stream ownership on failures before consumption; retain mandatory replica verification and strict purge agreement. |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | FIX WQ-024 | Raw request material is compared with normalized persisted material. Keep the append outcome table, exact common-prefix repair and explicit two-owner cleanup. |
| `packages/artifact-store/src/index.ts` | KEEP | Clear public capabilities and separate type exports; no public arbitrary-key signing or control-ledger deletion API. |
| `packages/artifact-store/src/object-store-telemetry.ts` | FIX WQ-023 | Observer invocation is guarded but argument classification is not. Move the late type import with other imports when editing, without splitting the module solely for size. |
| `packages/artifact-store/src/s3-client-contract.ts` | KEEP | Explicit overloads contain the unknown provider-output boundary and retain command-specific return types. Do not replace with a broad result union. |
| `packages/artifact-store/src/server-only.ts` | KEEP | Existing Node-only package contract. |
| `packages/artifact-store/src/store.ts` | FIX WQ-023, WQ-025; CONDITIONAL WQ-027 | Streaming verifier has explicit source ownership and post-header deadlines. PUT's HEAD validates itself but not its equality to the requested material. Preserve ambiguous-write retention. |
| `packages/artifact-store/src/workspace-purge-validation.ts` | KEEP | Prefix/version identity, duplicate and acknowledgement checks keep deletion scoped. Separate single-region page validation from the coordinator's strict comparison; neither should be weakened for readability. |
| `packages/artifact-store/test/artifact-request-lifecycle.test.ts` | TEST WQ-022 | Ordinary Error and primitive foreign reasons do not cover pre-abort rejection consumption or hostile inspection. |
| `packages/artifact-store/test/config.test.ts` | KEEP | Defaults, immutable config, invalid grammar and regional collisions exercised through parsers. Label anonymous invalid cases when extending them. |
| `packages/artifact-store/test/control-ledger-bucket-policy.test.ts` | KEEP | Independent policy-recognition matrix covers malformed values, action wildcard matching and insufficient protection. |
| `packages/artifact-store/test/control-ledger-config.test.ts` | KEEP | Dedicated configuration and all four control/artifact bucket collisions asserted. |
| `packages/artifact-store/test/control-ledger-part-2.test.ts` | REFACTOR/TEST WQ-026 | Descriptive readiness/policy filename would communicate ownership better than part number. Retain adapter-level proof that failed readiness prevents append/reconcile. |
| `packages/artifact-store/test/control-ledger.integration.test.ts` | TEST/FIX WQ-026 | Four suite-level S3 clients lack teardown. Provider qualification is intentionally separate; setup changes protected bucket policies and must stay explicitly gated. |
| `packages/artifact-store/test/control-ledger.test.ts` | TEST WQ-024; REFACTOR WQ-026 | Strong canonical-byte oracle and chain checks. Several tests combine independent scenarios; signal-presence assertion alone does not prove cancellation propagation. |
| `packages/artifact-store/test/dual-region-artifact-store.test.ts` | TEST WQ-027 | Current put fake consumes the stream before failing, hiding pre-consumption failures. Existing close, partial-write, conflict, signal and verification matrices remain valuable. |
| `packages/artifact-store/test/dual-region-control-ledger.test.ts` | TEST WQ-024; REFACTOR WQ-026 | Fixed-output fake does not normalize request fields, so it cannot expose single/coordinator normalization drift. Preserve exact common-prefix and both-settle cancellation tests. |
| `packages/artifact-store/test/object-store-telemetry.test.ts` | TEST WQ-023 | Observer-throws test covers only the callback; add classification failures before the callback. Real local signing is appropriately protected by client teardown. |
| `packages/artifact-store/test/s3-client-contract.test-d.ts` | KEEP | Positive GET/HEAD result checks and negative body/unsupported-command checks provide compile-time contract evidence. |
| `packages/artifact-store/test/store.integration.test.ts` | TEST WQ-026 | Real PUT/GET/signing path is useful, but fetches need bounded signals and response disposal. Existing finally preserves store close after rejected delete; do not silently claim removal of retained object versions. |
| `packages/artifact-store/test/store.test.ts` | TEST WQ-022, WQ-025; REFACTOR WQ-026 | Good corruption, ambiguous-write and stream-disposal cases. Large inline provider fake and mixed test responsibilities obscure ownership; checksum-mismatch test currently covers finalize, not PUT. |
| `packages/artifact-store/test/support/control-ledger.fixture.ts` | KEEP; small TEST WQ-026 | Purpose-built provider fake exposes explicit failure knobs and independent canonical key construction. Do not generalize into a shared storage framework. Make unsupported commands fail explicitly instead of all remaining commands falling into GET behavior. |
| `packages/artifact-store/package.json` | KEEP | Pinned provider dependencies, Node/browser boundaries and separate integration/typecheck scripts. |
| `packages/artifact-store/tsconfig.json` | KEEP | Existing emitted Node package with declarations and source-only build. |
| `packages/artifact-store/tsconfig.test.json` | KEEP | Source, test-d and config contracts checked without emit. |
| `packages/artifact-store/vitest.config.ts` | KEEP | Unit scope excludes provider integrations and generated output. |
| `packages/artifact-store/vitest.coverage.config.ts` | KEEP | All source included; numerical coverage does not substitute for failure-boundary cases. |
| `packages/artifact-store/vitest.integration.config.ts` | KEEP | Explicit integration file selection, with provider execution also gated in tests. |

## WQ-022 — P2: observe the operation even when cancellation already won

**Locations:** `src/artifact-request-lifecycle.ts:12`, `awaitWithSignal`;
`src/artifact-download.ts`, `signArtifactDownload`; `src/store.ts`,
`beginDirectUpload`; lifecycle and store tests.

Current structure:

```ts
signal.throwIfAborted();
return new Promise((resolve, reject) => {
  // ...
  void operation.then(resolveValue, error => {
    reject(error instanceof Error ? error : new Error(message, { cause: error }));
  });
});
```

Two controlled current-source probes established distinct consequences:

- Passing an already-rejected promise and pre-aborted signal throws the abort
  reason before attaching any rejection handler. A process-local
  `unhandledRejection` listener recorded `late provider failure`.
- Rejecting with a proxy whose `getPrototypeOf` throws causes `instanceof` in
  the rejection callback to throw. The derived, ignored promise rejects with
  `prototype trap`, while the wrapper promise remains unsettled after the
  microtask/event-loop checkpoint.

The callers check cancellation before calling the presigner, but an injected
presigner can synchronously abort the signal during invocation; the helper
must still own the promise it receives. These are synthetic local proofs,
not evidence that AWS has returned such rejection objects in production.

Attach success/rejection handlers on every path, including already-aborted
input. Make normalization total with a guarded Error test and a fresh Error
whose cause is the original unknown value. Centralize terminal settlement and
listener removal; no callback may throw into an ignored chain. Preserve
ordinary Error identity and the existing primitive-cause behavior. Do not
pretend rejecting the wrapper cancels a non-cooperative provider operation.

Acceptance: pre-abort plus later success/rejection; abort during presigner
invocation; normal success/error; abort after registration; hostile/revoked
proxy rejection and abort reason; late provider settlement after cancellation.
Assert one settlement, zero unhandled failures, listener cleanup and unchanged
ordinary Error identity. Use an isolated subprocess for process-level failure
assertions so the test runner's global error handling is not suppressed.

## WQ-023 — P2: protect classification as well as telemetry callbacks

**Locations:** `src/object-store-telemetry.ts:175`, `operationFor`, `errorClass`,
`ObservedS3Client.send`, `observePresign`; `src/store.ts`,
`ObservedArtifactStore.report`; `src/control-ledger.ts`,
`ObservedControlLedger.observe`; telemetry tests.

`safelyObserveRequest(observer, { errorClass: errorClass(error), ... })`
evaluates the unsafe classifier before entering the safe callback wrapper.
Current-source `observePresign(undefined, 'artifact', rejectHostileName)`
replaced the original rejection with `classification trap` from a `name`
getter. This occurs even with no observer. Signal reason inspection and the
two store-level `instanceof` reports have analogous unguarded inspection.

Guard each classification boundary and fall back to bounded `unknown`/no
safety classification when inspection fails; rethrow the exact original
business error. Do not wrap successful provider work in a catch that converts
a classification failure into a storage failure. Classify command identity
safely too, retaining `unknown` for unsupported test/adaptor commands.
Keep this package's small typed vocabulary; coordinate with WQ-015/WQ-018's
same principle without inventing a cross-package error framework.

Acceptance: throwing name/metadata getters, proxy prototype traps, revoked
proxy, hostile abort reason, throwing observer, undefined observer; verify
original rejection identity, unchanged successful result, at most one bounded
observation and no unhandled errors. Public store wrappers must also pass.

## WQ-024 — P2: compare normalized ledger request material on replay

**Locations:** `src/dual-region-control-ledger.ts:72`,
`requestMaterialMatches` and append pre-read branches at 215/222;
`src/control-ledger.ts`, `appendSchema` and `AwsControlLedger.append`;
single/dual ledger tests.

Single-region append uses trimmed `actorRef`, `reason` and `legalAuthority`.
The coordinator compares an existing normalized record with the original raw
request. A controlled probe composed two real source `createControlLedger`
instances over the existing in-memory provider fixture, with deterministic
regional readiness adapters:

```ts
const request = command({ reason: ' padded reason ' });
await dual.append(request); // stored reason is 'padded reason'
await dual.append(request); // ControlLedgerConflictError
```

This establishes broken package-level exact replay for admitted input, not a
claim that the HTTP command layer currently sends untrimmed material. The
same comparison also obstructs repair when only one normalized record exists.

Expose a private package-internal append-material parser from a cohesive
control-record module and use it before coordinator comparison and regional
dispatch. Keep the existing schemas/canonical bytes as the authority; do not
add a second list of fields to trim. Keep caller signal outside persisted
material. Preserve schema version, hashes, strict unknown-field rejection,
conflict semantics and no-write behavior when existing records disagree.

Tests: whitespace on every normalized field, both-record replay and each
one-sided repair, genuinely changed normalized material, invalid hold/deletion
variants, strict unknown fields, immutable hash fixtures and identical dispatch
material to both regions. Include a coordinator-plus-real-regional-adapter
test; fixed-output FakeLedger alone cannot establish normalization parity.

## WQ-025 — P2: compare PUT verification metadata with the requested artifact

**Locations:** `src/store.ts:650`, `AwsArtifactStore.put`; existing
`artifactMetadataMatches`; `test/store.test.ts`.

After PUT, the HEAD path validates metadata structure and identity, but PUT
only rejects `null`; unlike direct-upload validation it never compares the
returned material with the requested metadata. A source probe used a local
injected client that fully consumed the valid `hello` stream, then returned
otherwise-valid HEAD metadata with SHA-256 `a...a`. PUT succeeded and returned
the changed checksum (`metadataMatches: false`). No remote provider contacted.

After the existing missing-object check, use `artifactMetadataMatches` to fail
closed on differing byte length/media type/SHA-256. Retain the object on failure
for lifecycle reconciliation; never add compensating deletion after an
ambiguous write. Normal dual-region final verification already adds protection;
this finding is the single-store public contract, not demonstrated corrupt
database finalization.

Acceptance: individually valid changed checksum, media type and length in the
verification HEAD, missing object, malformed metadata, matching metadata,
post-upload cancellation and ambiguous provider failure. Assert no delete is
issued and ordinary success still returns the immutable expected metadata.

## WQ-026 — P2: make test ownership and failure cases explicit

**Locations:** integration suites; `store.test.ts` inline `MemoryS3Client` and
mixed listing/acknowledgement tests; `control-ledger.test.ts` combined chain,
timeout/ownership and reconciliation-signal tests;
`control-ledger-part-2.test.ts`; `dual-region-control-ledger.test.ts`.

Implement these as a test-maintenance unit after the correctness regressions:

1. Add independent teardown for all four suite-created S3 clients, registered
   before partial setup can fail. Preserve provider gates. Validate the provider
   selector before bucket setup so an unknown selector cannot mutate buckets
   while skipping every proof. These tests install policies/Object Lock and
   are not safe general-purpose smoke checks against arbitrary configured
   buckets; require dedicated fixture configuration and explicit execution.
2. Bound integration fetches and consume/cancel response bodies, including
   duplicate/error responses. State retained-version cleanup honestly rather
   than equating a delete marker with physical version erasure. Do not add
   destructive cleanup of immutable control-ledger objects.
3. Split tests with independent state changes into named cases. Rename
   `control-ledger-part-2.test.ts` to a readiness-oriented name and extract the
   store's large reusable provider fake to a support fixture if the split uses
   it. Preserve a literal canonical-byte oracle independent of production
   serialization; don't make tests tautological by importing that serializer.
4. The reconciliation-signal test only asserts three defined signals. Add
   controlled cancellation during anchor, batch and probe reads and assert
   rejection plus cleanup; presence does not establish propagation. Replace
   scheduler timing assumptions with explicit stage latches where practical.
5. The duplicate acknowledgement case currently supplies two responses for
   one requested object and fails at count validation. Use two requested
   identities with two identical acknowledgements to reach duplicate-identity
   validation. Name rows by violated invariant instead of only `%#`.

Acceptance: same retained safety assertions and passing unit/typecheck suites;
new setup-failure/selector tests must use fakes, not mutate live providers.
Real integration execution remains a separately authorized qualification.

## WQ-027 — P3 conditional: close stream ownership gaps at coordinator boundaries

**Locations:** `src/dual-region-artifact-store.ts`, `put` and
`replicateFromPrimary`; `src/store.ts`, early admission in `put`; corresponding
unit fakes and tests.

The coordinator obtains a primary download then immediately awaits
`recovery.put`. There is no coordinator finally destroying that download if
the receiver rejects before consuming it. The real single-region store also
validates metadata/limits before constructing its owning verifier; mismatched
directly supplied configs or a closed receiver can therefore reject before
taking stream ownership. Existing FakeArtifactStore consumes before failing.

First document and test the ownership transfer contract. Use a tracked real
Readable, receiver rejection before consumption, primary preflight HEAD
failure, cancellation, and normal successful streaming. If the coordinator
owns an acquired download until completion, add a narrow finally that destroys
it on all outcomes while preserving the original error. Do not indiscriminately
destroy caller input before an operation accepts ownership; settle that existing
contract explicitly. Do not claim an observed production socket leak: current
evidence is source-backed and the targeted ownership tests are still needed.

KEEP fallback: if existing callers/receiver contracts prove complete ownership
for every admitted configuration, retain the code and add that contract's
regression evidence. Do not replace functioning backpressure with full buffering
or rewrite all streaming around a generic lifecycle abstraction.

## Implementation order and acceptance

WQ-022 and WQ-023 first (independent defensive failure boundaries), then
WQ-024 and WQ-025 with their exact replay/integrity tests. WQ-026 can follow as
a coherent test-maintenance change; WQ-027 starts with ownership evidence.
Preserve the accepted regional topology, conditional immutability, canonical
ledger bytes, strict reconciliation/purge gates, bounded streaming, public
export contract and no-network-inside-database-transaction rule. No ADR is
required for these routine fixes unless an implementation proposes a genuinely
different ownership or architectural contract.

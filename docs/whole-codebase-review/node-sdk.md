# Node SDK — file-by-file judgment

Primary review: all 18 files read in full. Criteria refer to the
[rubric](../whole-codebase-quality-plan.md). Existing package tests run:
**2 files, 41 tests passed**. Three additional read-only, current-source
reproductions below expose cases those passing tests do not cover.

| File | Judgment | Reason / required work |
| --- | --- | --- |
| `packages/node-sdk/src/identity.ts` | KEEP — J01–J05 | Three related identity operations have real callers. The three-way comparison's nested ternary expresses lexical ordering followed by version ordering; replacing it with a class or policy object adds no clarity. The NUL delimiter cannot occur in schema-validated keys. |
| `packages/node-sdk/src/registry-binding.ts` | KEEP — J01, J05 | One shared check keeps dispatch-mode and execution error precedence aligned. Its small size does not make it useless. |
| `packages/node-sdk/src/compatibility-canonical.ts` | KEEP — J01, J05, J11, J13 | Compatibility projections deliberately differ from full object equality; preserve V1 omission semantics and selection fingerprints. The synchronous SHA-256 implementation serves the browser-safe synchronous contract and has independent Node digest comparisons at padding/Unicode boundaries. Cryptographic constants and bit operations are justified complexity. Clone helpers depend on admitted bounded JSON; WQ-003 repairs admission rather than adding independent validation to every recursive consumer. |
| `packages/node-sdk/src/release.ts` | FIX — WQ-002; otherwise KEEP | Successor checks separate immutable behavior from lifecycle changes clearly. Definition policy duplicates are not rejected, making the set-membership equality unsound. Do not merge definition/executor lifecycle checks into a generic configurable state-machine framework. |
| `packages/node-sdk/src/definitions/schema-document.ts` | FIX/REFACTOR — WQ-003 | Iterative member/depth traversal is appropriate, but final serialization reads the original object again and can execute a hidden `toJSON` getter. Share browser-safe admission mechanics with server normalization; keep Zod projection policy here. |
| `packages/node-sdk/src/json-boundary.ts` | FIX — WQ-004; REFACTOR with WQ-003 | Descriptor copying, explicit stack, repeated-reference rejection and own-data `__proto__` handling are valuable. Root/child container rules and browser/server traversal currently duplicate policy. Error normalization itself inspects a hostile thrown value through `instanceof`. |
| `packages/node-sdk/src/executor-contracts.ts` | KEEP — J01, J05, J06 | Explicit capabilities avoid giving executors database/provider implementations. Optional runtime/capabilities represent supported ABI and node differences, not automatically an invalid flag model. Keep bounded dispatch and artifact interfaces. |
| `packages/node-sdk/src/executor-errors.ts` | KEEP — J06, J08 | Named public error types encode distinct caller behavior; replacing them with generic strings loses contracts. Failure outcome grammar and retry duration bounds are explicit. Do not infer cross-field outcome constraints without checking worker classification. |
| `packages/node-sdk/src/server.ts` | REFACTOR/TEST — WQ-005 | Registry construction interleaves pinning, cross-registration validation, catalog construction and invocation execution in one 289-line closure. Existing exact binding and dispatch state are coherent. Preserve error order and four-state dispatch evidence; do not collapse it to independent booleans. |
| `packages/node-sdk/src/server-only.ts` | KEEP — J09, J13 | Early Node runtime assertion complements export conditions; it is not claimed to be a complete bundler sandbox. |
| `packages/node-sdk/src/index.ts` | KEEP — J05, J13 | Intentional browser-safe release facade, not accidental forwarding. |
| `packages/node-sdk/test/registry.test.ts` | TEST/REFACTOR — WQ-002–WQ-005 | Independent digest comparisons, cancellation precedence, hostile descriptors, exact bindings and deferred dispatch tests are useful. Current order-independence test reverses singleton lists, so it does not prove permutation independence. One ABI-2 test combines successful, missing, duplicate, concurrent, rejected and in-flight behavior with shared mocks. Split by behavior, retain deterministic deferred markers, and add the three reproduced regressions. |
| `packages/node-sdk/test/package-contract.test.ts` | KEEP — J12, J13 | Inspects actual exports and invokes transitive browser dependency validation. The first-import assertion is intentionally a structural contract; do not replace behavioral registry tests with more source-string checks. |
| `packages/node-sdk/package.json` | KEEP — J13 | Explicit browser-safe default/release and Node-only server export conditions; only Zod is a runtime dependency. |
| `packages/node-sdk/tsconfig.json` | KEEP — J13 | ES2024/NodeNext compiled declarations plus DOM types support shared browser contracts and AbortSignal. Preserve existing build. |
| `packages/node-sdk/tsconfig.test.json` | KEEP — J12, J13 | Source, test and Vitest configuration are typechecked without production emission. |
| `packages/node-sdk/vitest.config.ts` | KEEP — J12 | Simple Node runner excluding built/dependency files; no unnecessary environment machinery. |
| `packages/node-sdk/vitest.coverage.config.ts` | KEEP — J12 | Includes all source and explicit thresholds/output. Passing percentages cannot establish missing hostile-object or permutation cases. |

## WQ-002 — reject duplicate definition policies before equality

**P2 FIX, reproduced.** `release.ts:328`, `sameIdentityLists:377`.

```ts
if (left.length !== right.length) return false;
const rightTokens = new Set(right.map(identityToken));
return left.every((identity) => rightTokens.has(identityToken(identity)));
// left=[p,p], right=[p,q] => true
```

`createRegistryRelease` accepted and fingerprinted a definition with `[p,p]`
bound to an executor with `[p,q]`, with both policies declared. Executor policy
duplicates are rejected later, but definition policy duplicates are not. This
violates the release edge check's stated equality. The server's sorted
comparison subsequently rejects the mismatch; this is inconsistent release
admission, **not evidence of an authorization bypass in executing nodes**.

Plan:

1. Add `rejectDuplicateIdentities('definition policy', manifest.policyReferences)`
   at the definition-validation phase before comparing policies. Keep list
   order irrelevant and duplicate identities invalid. Consider renaming the
   helper to `sameUniqueIdentities` to state its precondition; do not silently
   deduplicate malformed releases.
2. Add public create/parse tests for duplicate-left/missing-right, duplicates
   on both sides, unknown policies, differing versions, and valid reordered
   unique references. Parse a malformed release with a recomputed fingerprint
   so the test exercises edge validation, not merely fingerprint rejection.
3. Preserve fingerprints and acceptance for all valid retained fixtures.
   No migration, published manifest rewrite, or new schema version is needed.

Acceptance: malformed duplicate policies fail before release creation/parsing
returns; valid permutations remain accepted and fingerprint-equivalent. Run SDK
tests/typecheck and node-catalog compatibility tests. Independent of WQ-003.

## WQ-003 — inspect and measure the same JSON snapshot

**P2 FIX + focused REFACTOR, reproduced.**
`definitions/schema-document.ts:21` (`inspectBoundedNodeJson`), especially final
`JSON.stringify(value)`; `json-boundary.ts:44` (normalizing traversal).

```ts
let calls = 0;
const value = Object.defineProperty({ large: 'x'.repeat(1_048_576) }, 'toJSON', {
  get() { calls++; return () => ({}); }, // non-enumerable by default
});
isBoundedNodeJson(value); // true; calls === 1
canonicalizeBoundedJson(value); // InvalidBoundedJsonError: byte limit
```

The descriptor walk sees only the large enumerable data property, while the
final serialization invokes the hidden hook and measures `{}`. Thus admission
executes a getter and accepts data whose descriptor snapshot exceeds the byte
limit. A proxy `get` trap can similarly disagree with descriptor inspection.
This is a local API reproduction, not a claim that network JSON can contain
getters or that a deployed tenant exploit has been established.

Proposed shape: one **private browser-safe bounded JSON traversal** produces a
plain own-data snapshot (or a structured failure result), counting depth and
members and measuring serialization of that snapshot. Both the browser boolean
predicate and server canonicalizer consume it. Keep SDK server error classes
out of the browser import graph. Move the limits constant to that private
module if needed to avoid a `release -> schema-document -> release` runtime
cycle. Schema projection and Zod integration remain in schema-document.

Preserve: negative-zero normalization, exact UTF-8 byte limits, depth convention,
member totals, null-prototype input, repeated-reference rejection, sparse and
extra-property array rejection, symbols, enumerable accessor rejection, and
own-data `__proto__`. Do not accidentally promise to eliminate every Proxy
reflection trap: JavaScript introspection may invoke traps, whose failures must
be contained. Non-enumerable non-JSON properties can remain ignored, but must
never execute during measurement.

Tests: root/nested hidden `toJSON` getter and method; method returning tiny data
while enumerable data is oversized; proxy `get` trap with safe descriptors;
null-prototype objects; exact/over UTF-8, member and depth boundaries. Assert
getter/method calls remain zero and browser/server admission agrees. Existing
valid compatibility fingerprints must remain identical. Run browser dependency
gate, SDK tests/typecheck, catalog and workflow-model bounded-input cohorts.
Implement with WQ-004 so the shared traversal does not inherit unsafe catch logic.

## WQ-004 — do not trust thrown values while normalizing inspection failures

**P2 FIX, reproduced.** `json-boundary.ts:173`.

```ts
catch (error) {
  if (error instanceof InvalidBoundedJsonError) throw error;
  throw new InvalidBoundedJsonError('value could not be inspected safely');
}
```

A source proxy's `getPrototypeOf` trap can throw another proxy whose own
`getPrototypeOf` throws. The `instanceof` above executes the second trap. Local
probe observed plain `Error('secondary trap escaped')`, not
`InvalidBoundedJsonError`. Existing tests throw ordinary Errors only.

Preferred with WQ-003: traversal returns trusted failure reasons for its own
validation failures; its outer catch discards arbitrary external exceptions
without reading them. Server wrapper constructs a fresh stable error from the
trusted reason. If kept separate, protect classification with its own catch and
never inspect arbitrary `.message`, `.name`, `.cause` or stringify thrown data.
Preserve ordinary limit-specific reasons; do not introduce a generic repository
error framework. Add root/nested proxy, revoked proxy, thrown proxy and primitive
throw cases through the exported canonicalizer; every failure must expose the
stable error class/code without running secondary trap inspection.

Also audit `server.ts:237`'s release-error normalization in this same package:
it performs `error instanceof Error` and `.message`. Normalize safely there if
the release parser throws a hostile value, while retaining `registry_compatibility`.
Add a public registry-construction regression; this secondary path has source
evidence and is not included in the three executed reproductions above.

## WQ-005 — separate registry construction phases and test behaviors

**P2 REFACTOR/TEST, not a demonstrated execution defect.** `server.ts:233–520`;
`test/registry.test.ts:253` and ABI-2 test beginning near line 753.

Keep the existing `NodeRegistry` interface. Inside the same module, introduce
private named phases for validated executor pinning and cross-registration
coverage, returning the existing pinned maps. A reader should see:

```ts
const release = parseCompatibleRelease(options.release);
const pinned = pinRegistrations(release, options.definitions, options.executors);
// Build catalogs and invocation closures using this immutable pinned snapshot.
```

Names are illustrative, not a mandate for one-line wrappers. Move the substantive
registration checks and snapshot construction as a cohesive block; avoid a
helper per guard or a generic validation pipeline. Preserve first-failure order,
exact identities, missing-definition/executor distinctions, schema projection
checks, supported ABI checks, catalog semantics and metadata snapshotting.
Do not remove repeated release checks until tests prove their error behavior
is redundant; WQ-002 shows the danger of assuming upstream validation is complete.

Split registry tests into release compatibility, bounded JSON and server
execution cohorts, with one small valid-release fixture shared where necessary.
Split the multi-scenario ABI-2 test into isolated tests for success, missing
runtime/marker, duplicate, concurrent, rejected and in-flight marker behavior.
Maintain controlled deferred promises and drain them; do not add arbitrary sleeps.
Use at least two definitions/executors/policies in order-independence tests and
permute nested identity lists as well as top-level arrays. Keep Node crypto as
the independent digest oracle.

Acceptance: all public assertions retained, new permutations actually differ,
each dispatch failure identifies its own test, no new public exports, no state
or error-precedence changes. Run SDK tests/typecheck and package-contract gate.
Perform after WQ-002–WQ-004 so the refactor is judged against repaired contracts.

# `@pertexo/node-sdk` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all four source files and all 1,803 physical source
  lines.
- **Test scope:** both package test files and all 967 physical test lines, plus
  every direct production import, node-catalog staged/active release tests,
  nodes-core and integration registrations, workflow-engine compatibility
  consumers, worker execution consumers, package scripts, and CI execution.
- **Architecture sources:** the authoritative backend plan and ADRs 001, 005,
  007, 010, 011, 016, and 022 through 025.
- **Audit status:** complete for the pinned tree.
- **Implementation status:** two high-priority correctness/security defects,
  five medium contract/design/control gaps, and three lower-priority robustness
  or maintainability improvements remain open.

The package is necessary and owns the right domain boundary. It is the common
compatibility language between browser-safe node manifests, workflow
compilation, retained releases, and server-only executor implementations. It
correctly prevents browser code from resolving the server entry, pins exact
definition/executor/policy identities, fingerprints compatibility projections,
enforces lifecycle transitions, validates runtime schemas against published
documents, and prevents latest-version fallback.

The implementation is generally deliberate, but it is not yet “as good as it
can be.” The most serious issue is at the unsafe-side-effect seam: two concurrent
calls to the ABI-2 `beforeDispatch` wrapper can both reach the durable marker
before the duplicate guard changes state. The invocation ultimately fails, but
two dispatch preparations have already occurred. A separate object-copy defect
handles an own `__proto__` JSON key as prototype mutation. The canonicalizer
silently loses that data, and release freezing can create a release that the SDK
itself subsequently rejects.

The module also publishes JSON Schema projections that cannot express Zod
refinements, while presenting equality with a regenerated projection as schema
parity. Provider executors parse configuration and input again because the
definition and executor registration interfaces do not preserve their generic
type relationship. Finally, nearly all implementation lives in two 845/953-line
files even though compatibility lifecycle, hashing, schema projection, JSON
admission, runtime capabilities, error taxonomy, and execution are distinct
owners. Those files should be split along those seams while preserving the
current small package export map.

## Evidence collected

The review used full-file reading, complete export/internal-callable inventory,
repository-wide symbol and import searches, consumer tracing, plan/ADR
comparison, TypeScript compilation, package build, ESLint, all package tests,
ad hoc V8 coverage, and targeted runtime counterexamples. The counterexamples
were run against the compiled package, not inferred from source alone.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/node-sdk typecheck` | Passed |
| `pnpm --filter @pertexo/node-sdk build` | Passed |
| `pnpm --filter @pertexo/node-sdk test` | 2 files and 24 tests passed |
| `pnpm exec eslint packages/node-sdk/src packages/node-sdk/test` | Passed |
| Ad hoc package-source V8 coverage | 88.29% statements, 75.41% branches, 95.65% functions, 89.57% lines |
| Hostile-key canonicalization | own `__proto__` admitted, removed as data, installed as result prototype |
| Release round trip | release with `properties.__proto__` became unparsable after clone/freeze |
| Array parity | array with an extra enumerable property rejected by browser predicate but accepted and truncated by server canonicalizer |
| Concurrent dispatch | two simultaneous wrapper calls invoked the durable marker twice, then failed with `dispatch_evidence_missing` |
| Refinement projection | runtime rejected `denied`; generated JSON Schema accepted any string |
| SHA-256 differential check | 10 empty, padding-boundary, long, and Unicode projections matched `node:crypto` |
| Successor counterexample | epoch 1 advanced directly to 999 with an unchanged fingerprint |
| Proxy counterexample | predicate, Zod `safeParse`, and canonicalizer leaked the proxy trap error |

Coverage was generated explicitly for this audit. It is not a repository gate:
the package has no `test:coverage` script and is absent from the root critical
coverage command.

## Architecture and ownership

### Module purpose and dependency direction

`node-sdk` is a foundational Module with two public Interfaces:

- the default/`./release` Interface is browser-safe compatibility data and
  deterministic release construction;
- the `./server` Interface adds executor/runtime capabilities and the executable
  registry.

That Seam is correct. The package depends only on Zod and platform JavaScript
APIs. It imports no NestJS, Drizzle, PostgreSQL, Redis, BullMQ, workflow-engine,
provider, or application module. Consumers point inward in the intended order:
node definitions and integrations implement SDK contracts; node-catalog
composes releases; workflow-engine consumes exact compatibility metadata; and
worker execution supplies runtime capabilities. The browser entry cannot
transitively import `node:` or `server.ts`.

The package has high Leverage: changing a manifest, fingerprint, JSON boundary,
or execution contract affects publication and retained execution across the
repository. That makes its limited dependencies and exact-version behavior
valuable. It also means its boundary code requires stronger tests than an
ordinary utility package.

### Depth, Interface size, and Locality

The conceptual module is deep, but the source layout and typing reduce that
Depth:

- `release.ts` exposes 35 runtime/type symbols and implements contracts,
  validators, bounded-JSON admission, schema generation, deep freezing,
  canonical serialization, SHA-256, release edge validation, selection
  fingerprinting, and lifecycle succession.
- `server.ts` exposes 38 runtime/type symbols and implements capability ports,
  error classes, JSON canonicalization, registration helpers, release matching,
  catalogs, dispatch-mode selection, and node execution.

The three package subpaths are appropriately few, but each subpath has a broad
symbol surface and the two implementation files have low Locality for changes.
A change to SHA behavior and a change to lifecycle rules share one file; a
change to artifact runtime capabilities and a change to JSON traversal share
another. The authoritative plan proposed `definitions/`, `executors/`,
`triggers/`, `credentials/`, and `testing/` ownership. The current flat shape is
not wrong merely because it differs, but the now-grown Implementation has
crossed the point where those real seams deserve internal modules.

The recommended split preserves `index.ts`, `release.ts`, and `server.ts` as
facades and does not create more public subpaths:

```text
src/
  release.ts                         browser-safe public facade
  definitions/contracts.ts           identities, manifests, Zod schemas
  definitions/json-boundary.ts       browser-safe bounded JSON predicate/docs
  compatibility/canonical.ts         canonical projection and hashing
  compatibility/lifecycle.ts         edge and successor validation
  server.ts                          server-only public facade
  executors/contracts.ts             invocation and capability ports
  executors/errors.ts                stable execution error taxonomy
  executors/json-boundary.ts         validated canonical copy
  executors/registry.ts              registration and execution registry
```

Do not add empty trigger/credential/testing directories merely to resemble the
plan. Extract only current ownership. The existing root and server Interfaces
must remain compatible while internal modules improve navigation and testing.

## Complete production-code review

### `src/index.ts`

The one-line re-export is correct. It deliberately makes the default package
Interface identical to `./release`, which package-contract tests verify. A
named export list would duplicate a large public inventory without improving
the browser/server boundary. `.js` is the correct NodeNext emitted path.

### `src/server-only.ts`

The guard is minimal and imported before all server implementation code. The
export map and `browser: false` mappings are the primary protection; the runtime
check is defense in depth. The unbraced single-line `if` follows current lint
rules but braces would make this security boundary less fragile under edits.
The unreachable non-Node branch is expected to remain uncovered in Node tests.

### `src/release.ts`: contracts and validation

`DefinitionIdentity`, `ExecutorIdentity`, and `PolicyReference` correctly use
separate structural types even though their shapes match. Exact identity is
key plus positive integer version; no comparator exposes “latest” selection.
The lower-case dot-namespaced key regex matches ADR-010.

The definition and executor lifecycle unions and frozen transition maps match
ADR-010. Keeping the transition data exported is useful for tooling and tests.
`RetryClass`, `ResourceClass`, families, ports, integration identity, and
capability metadata are correctly browser-safe.

`NodeManifest`, `ExecutorManifest`, and `RegistryRelease` are precise immutable
shapes, but `executorAbi` being optional weakens a compatibility-critical field.
Current core ABI-1 manifests omit it while integration/advanced manifests pin
it. The release edge validator can therefore prove an ABI match only when the
definition supplies the field. ADR-010 says the executable envelope pins the
executor ABI. Existing retained fingerprints prevent casually making the field
required in version 1, so a future manifest schema version should remove this
optional state (SDK-009).

`isBoundedNodeJson` uses iterative traversal, rejects cycles/shared references,
accessors, sparse arrays, symbols, non-finite numbers, and non-plain objects,
and applies depth/member/serialized-byte limits. Avoiding recursive calls is a
good security property. It correctly treats `-0` as valid JSON; server
canonicalization normalizes it to `0`.

The predicate is not exception-total. Proxy traps from `getPrototypeOf`,
`getOwnPropertySymbols`, `Object.keys`, property descriptors, or stringify
escape instead of returning `false`. Normal HTTP `JSON.parse` values cannot be
proxies, but this is a public type predicate and is also applied to values
created by trusted package code. Its contract should either explicitly require
ordinary objects or normalize all introspection failures (SDK-008).

`boundedNodeJsonSchema` and `boundedNodeJsonRecordSchema` correctly share the
predicate, and the two precomputed JSON Schema documents add the platform limit
extension. Their object type is semantically a bounded JSON record, although
the name `SchemaDocument` is reused for ordinary node values and actual JSON
Schema documents. Distinct `BoundedJsonObject` and `JsonSchemaDocument` names
would reduce conceptual overload during the internal split.

`identitySchema`, `portsSchema`, integration validation, manifest schemas, and
release schemas are strict. Duplicate port/capability/requirement strings are
rejected. Release-edge validation separately proves unique identities,
bidirectional definition/executor edges, ABI agreement when pinned, identical
policy sets, and known policies.

Collection cardinality and identifier length are not bounded beyond individual
identity/provider keys. Releases are deployment-controlled rather than public
request payloads, so this is not currently an exploit finding. If release JSON
ever becomes operator-uploaded or remotely synchronized, add total release-byte
and collection-count limits before parsing/fingerprinting.

### `src/release.ts`: schema documents

`generateSchemaDocument` has a convenient Interface and special-cases the two
bounded JSON schemas so consumers see Pertexo's runtime limits. For ordinary
Zod schemas it delegates to `z.toJSONSchema`, validates bounded JSON, clones,
and freezes the result.

JSON Schema cannot encode arbitrary Zod refinements. A direct refined-string
test generated only `{ type: "string" }` while runtime parsing rejected the
counterexample. Real consumers already rely on refinements for canonical
timezones, cross-field Merge state, header restrictions, URLs, and other
semantics. `validateDefinitionRegistration` regenerates the same lossy
projection and compares it with the manifest, so it proves projection identity,
not browser/runtime semantic equivalence (SDK-004).

The correct design is not to claim arbitrary refinements can be translated.
Mark runtime-only semantics explicitly, require an equivalent representable
JSON Schema/extension when browser validation needs them, and maintain a shared
acceptance/rejection fixture corpus through both validators. Compatibility
fingerprints must change through a new definition version when the published
contract changes.

### `src/release.ts`: cloning and canonical fingerprints

`cloneAndFreeze` recursively owns and freezes release data, which prevents
callers from mutating compatibility state after fingerprinting. Its plain-object
copy uses `copy[key] = value`; the magic `__proto__` setter therefore changes
the clone's prototype rather than defining an own JSON property. This corrupts
valid JSON Schema documents with a property literally named `__proto__`. The
audit constructed such a schema, created a release, and found that the returned
release failed `parseRegistryRelease` (SDK-002).

Use null-prototype dictionaries or `Object.defineProperty` for untrusted keys,
and cover root/nested `__proto__`, `constructor`, and `prototype` names. The
result should retain exact own enumerable data and remain deeply frozen.

`stableJson` sorts object keys and preserves array order. Projection helpers
sort set-like identities, requirements, capabilities, and ports so declaration
order does not change compatibility identity. Sorting port lists intentionally
treats named port membership—not declaration order—as behavior. If future UI or
execution semantics make port order meaningful, that requires a fingerprint
schema revision.

The synchronous browser-safe SHA-256 implementation is justified: Web Crypto is
asynchronous while the existing compatibility functions are synchronous, and
importing Node crypto would violate the browser seam. The package test compares
one real projection with Node crypto. This audit additionally compared empty,
Unicode, 55/56/63/64/65-byte-boundary, and long projections; all matched. The
algorithm is intentional complexity and should not be split into clever helper
fragments. Its differential vectors should become permanent tests (SDK-007).

`definitionProjection`, `executorProjection`, and `releaseProjection` include
the compatibility-relevant fields and exclude epoch as admission provenance.
Selection fingerprints correctly include only selected definitions, their exact
executors, and policies, so unrelated catalog additions do not manufacture new
workflow versions.

`validateReleaseEdges` is cohesive and fail-closed. Linear maps and sorts are
appropriate for startup-sized release catalogs. A staged executor must declare
its future definition, making the definition active but non-placeable until the
executor advances to active; node-catalog tests deliberately prove staged
releases are not executable.

`createRegistryRelease`, `parseRegistryRelease`, and
`createRegistryReleaseSuccessor` correctly separate bootstrap/historical parse
from audited lifecycle progression. The successor enforces immutable behavior,
monotonic allowed states, staged new executors, active new definitions, and
retire-before-removal.

The successor accepts any larger epoch and accepts a no-op successor with the
same fingerprint. The audit advanced epoch 1 directly to 999 without changing
the release. Current repository callers always use `previous.epoch + 1`, and
durable activation carries separate predecessor evidence, so this is not a
current production failure. Still, the helper's promise of one audited
successor is weaker than its name/comment suggest (SDK-010).

### `src/server.ts`: runtime contracts and errors

The server Interface defines the useful capability ports without importing
their implementations:

- `NodeConnectionRuntime` resolves an opaque connection and can fence its
  current secret version;
- `NodeArtifactRuntime` writes bounded streaming output;
- `NodeExecutionRuntime` carries exact attempt identity, side-effect class,
  stable provider keys/bindings, optional capabilities, and the durable
  pre-dispatch callback.

This is good dependency inversion. The worker is the Adapter that implements
these ports; integrations consume them without importing worker/database code.
Optional capabilities allow core CPU nodes to execute without provider
infrastructure. Secret bytes remain server-only.

`NodeExecutorFailure` validates a finite failure vocabulary before constructing
the error. `ProviderExecutionRateLimitError` validates a bounded integer delay.
The `NodeSdkError` hierarchy gives registry, lookup, abort, validation, JSON,
runtime, and dispatch-evidence failures stable codes. Specific subclass names
are set correctly. Schema errors retain their original cause without exposing
it in the public message.

`NodeExecutorFailure` and `ProviderExecutionRateLimitError` do not extend
`NodeSdkError`; this is intentional because they represent executor/provider
outcomes handled by worker policy, while registry boundary errors represent SDK
contract failures. The distinction should be documented near the classes so a
future catch block does not flatten them.

`NodeExecutionInvocation` is generic, but `NodeExecutorRegistration.execute`
erases both values to `unknown`. `NodeDefinitionRegistration` independently
stores untyped `ZodType`s, so TypeScript cannot prove that one executor receives
the schemas belonging to its supported definition. Runtime registry checks
prove identity/document edges but not the generic relation (SDK-005).

`TypedExecutorRegistration` adds an unused optional phantom `__types` function,
and `defineNodeExecutor` is exported but has no production or test consumer.
Its implementation parses config/input after the registry has already parsed
them. The three provider executors independently repeat that parsing today.
This is an unsuccessful abstraction: it neither owns registration composition
nor removes repeated validation.

### `src/server.ts`: bounded canonical JSON

`canonicalizeBoundedJson` iteratively validates and copies an untrusted node
execution envelope. It normalizes negative zero, rejects non-JSON types,
accessors, cycles/shared references, sparse arrays, symbols, non-plain objects,
and depth/member/byte overflow. Copying before schema parsing prevents mutable
executor/request aliases from crossing the registry boundary.

Two parity/copy defects remain:

- object assignment turns an own `__proto__` key into prototype mutation and
  removes it from canonical JSON;
- array traversal synthesizes only numeric index keys and never checks that
  `Object.keys(array).length === array.length`, so extra enumerable properties
  are silently discarded even though `isBoundedNodeJson` rejects them.

The first joins SDK-002; the second is SDK-003. One shared, browser-safe
admission/canonical-copy implementation would prevent these two versions from
drifting. If the server must return a copy while the browser needs only a
predicate, both should use the same traversal kernel and tests.

The custom `limits` argument is public but not validated as positive safe
integers. `NaN` limits allowed `{}` during the audit. Proxy traps also escape as
arbitrary errors, and the serialized byte limit is checked only after the
entire copy/string has been allocated. These are robustness concerns grouped in
SDK-008. Default production limits are valid constants, and ordinary parsed
JSON cannot trigger proxy behavior, so they are lower priority than data loss.

### `src/server.ts`: registry construction and execution

`validateDefinitionRegistration` reparses manifests, finds the exact release
identity, compares full stable manifest data, regenerates schema documents, and
returns the runtime schemas. `createNodeRegistry` then proves unique local and
release identities, exact executor ABI/lifecycle/definition/policy metadata,
complete implementations, bidirectional bindings, compatible policies, and an
executable lifecycle. Missing, staged, and retired implementations fail closed.

The three catalog views correctly distinguish placement, publication, and
history. Returning only identities keeps the Interface small. Catalog arrays
are copied, sorted, and frozen. Resolving exact identity rather than latest
version implements ADR-010.

`dispatchMode` correctly derives ABI-1 `before_execute` versus ABI-2
`executor_controlled` and rechecks the definition/executor binding. The worker
uses this to place its own pre-execution marker for ABI 1.

`execute` correctly:

1. rejects a signal already canceled;
2. resolves exact definition/executor identities and binding;
3. bounds the aggregate config/input/connection envelope;
4. maps config/input/connection schema failures to stable errors;
5. requires runtime context for ABI 2;
6. delegates to the exact executor;
7. requires one ABI-2 dispatch marker;
8. bounds and validates executor output, including schema transforms; and
9. derives terminal success only from the pinned capability.

Preserving a confirmed successful result after cancellation races with executor
completion is deliberate and tested. Re-canonicalizing after output parsing is
also justified because a Zod transform could create a non-JSON value.

The `beforeDispatch` wrapper checks `dispatchCount`, awaits the underlying
durable marker, and increments afterward. Two concurrent calls both observe
zero and both invoke the marker. The registry later observes count two and
reports missing rather than duplicate evidence, but cannot undo the duplicate
preparation (SDK-001). The guard must reserve the one permitted call
synchronously before awaiting, while still distinguishing marker failure from a
committed marker. Tests must control the promise interleaving rather than make
only sequential calls.

`createNodeRegistry` is 276 lines because it performs one startup validation
transaction and builds closures over validated maps. Its control flow is
currently understandable, but registration validation/catalog construction and
execution are separate owners. Splitting them behind a private validated-state
type would improve Locality without creating a facade around each small helper
(SDK-006).

## Consumer and integration review

### Node packages

`nodes-core` and `integrations` import browser-safe contracts/schema generation
from the root and runtime contracts from `./server`. Their browser entries do
not import the server path. This is the intended two-Interface dependency.

All eleven core nodes manually construct `NodeExecutorRegistration` with
unknown invocation types. The three provider executors parse config and input
again inside their handler. Forty-two manifest schema projections are generated
across node packages. This demonstrates enough real callers for a better paired
definition/executor registration seam; it is not a hypothetical abstraction.

### Node catalog

`node-catalog` is the principal composition Adapter. It builds the exact
staged/active release chain, selects only supported durable identities, joins
release manifests to local Zod registrations and executable implementations,
then delegates all runtime checks to `createNodeRegistry`. Its tests prove that
staged releases cannot execute and active releases can. The SDK's current
staging behavior therefore survives integration.

### Workflow engine, API, and worker

Workflow-engine uses release parsing, exact selection fingerprints, executable
compatibility, and `NodeExecutorFailure`; it does not import executor
implementations. API node testing uses `RegistryRelease` as a boundary type and
depends on node-catalog for resolution. Worker supplies runtime capabilities,
maps dispatch evidence, provider rate limits, and executor outcomes, and never
substitutes a newer executor. These dependency directions follow the plan.

The ABI-2 race can be triggered by a buggy or adversarial executor calling its
provided runtime concurrently. Current built-in integrations call it once, so
the defect is latent rather than observed in normal flows. The SDK exists to
make that invariant impossible for every executor; relying on current Adapter
discipline is insufficient.

## TypeScript, readability, reuse, and code cleanliness

- Naming is domain-specific and consistent. Identity, lifecycle, release,
  selection, dispatch evidence, and catalog terms align with ADR-010/ADR-007.
- Imports preserve browser/server direction and use `type` modifiers correctly.
- Strict Zod schemas, readonly types, exact identities, and discriminated error
  data make invalid ordinary states difficult to express.
- Control flow favors early guards and small comparison helpers. Nested
  conditionals are limited despite the compatibility matrix.
- Comments explain why synchronous hashing, iterative traversal, and exact
  identities exist. They do not narrate obvious syntax.
- `identityToken`, identity comparison, and stable comparable/canonical sorting
  are duplicated between release/server because browser/server ownership
  prevented an import from the server into release. They should move to one
  browser-safe internal module during SDK-006, not become new public utilities.
- Repeated frozen copies are appropriate at the compatibility boundary. The
  finding is unsafe copying for hostile keys, not “too much immutability.”
- `defineNodeExecutor`/`TypedExecutorRegistration` fail the deletion test in
  their current form: removing them changes no production consumer. Either
  redesign and adopt them as the one typed registration owner or delete them
  after workspace verification.
- The custom SHA-256 is not useless reinvention under the synchronous browser
  Interface. Replacing it requires either an API-breaking async boundary or a
  vetted synchronous browser-safe dependency with less total risk.
- The package has no circular dependency, framework leakage, global mutable
  registry, dynamic discovery, decorators, base-class hierarchy, or needless
  repository/service facade.

## Test and CI assessment

### What the tests prove

`package-contract.test.ts` validates the export map, root/release parity,
absence of Node/server imports from browser sources, and the server guard's
first statement. These are valuable architectural tests, although two checks
inspect source text and must be updated if imports are reorganized without
changing behavior.

`registry.test.ts` proves error-kind bounds, exact lifecycle transition tables,
immutable identity behavior, staged additions/removals, declaration-order-
independent fingerprints, Node-crypto agreement for one release, integration
metadata, deep schema rejection, selection isolation, bounded JSON parity for
common edges, duplicate identities, schema-document drift, private registry
state, aggregate input limits, ABI-2 marker presence and sequential duplicates,
unknown ABI rejection, terminal capability behavior, cancellation semantics,
stable schema errors, lifecycle catalogs, retained execution, and exact-version
lookup.

These tests are useful and behavior-oriented. They are not tests written only
to increase a count. Their main weakness is omitted adversarial/concurrent
cases, not low assertion value.

### Test organization

`registry.test.ts` is 902 lines and combines release hashing/lifecycle, JSON
security boundaries, registry construction, execution, errors, catalogs, and
dispatch concurrency. Shared fixtures are legitimate, but the file now has at
least four ownership groups. Split it into release lifecycle/fingerprint,
bounded JSON/schema documents, registry construction/catalogs, and execution/
dispatch tests. Keep one fixture builder rather than copying the 60-line
manifest/release setup.

The package lacks permanent tests for hostile property keys, extra array
properties, proxy/introspection failures, invalid custom limits, concurrent
marker calls, no-op/gapped successors, schema refinement divergence, and SHA
padding/Unicode boundaries. Some lifecycle/error branches are also uncovered.

### CI execution and coverage

GitHub Actions includes `@pertexo/node-sdk` in the package matrix, so build,
lint, typecheck, and 24 tests run on CI. Root `pnpm check` and the pre-push hook
also execute them. Passing means the current asserted behaviors pass; it does
not mean every branch or risk has been tested.

The root `test:coverage` command covers workflow-engine, database, worker, and
API only. It neither measures nor thresholds node-sdk. Current ad hoc figures
are strong in functions but leave 88 of 358 branches uncovered. A foundational
trust/compatibility package should own an enforced coverage threshold and
durable reviews for intentionally unreachable branches (SDK-007).

## Plan and ADR compliance

The package complies with the plan and ADR-010 on the major architecture:

- browser manifests and server executors are separated;
- instances/releases refer to exact definition and executor identities;
- fingerprints are deterministic and insensitive to unrelated declaration
  order;
- selection fingerprints isolate referenced compatibility;
- lifecycle transitions and retire-before-remove policy are encoded;
- staged executors cannot serve execution;
- retained/retirement-blocked executors remain executable;
- exact policies and ABI are checked where the manifest pins ABI;
- browser/server package maps are explicit; and
- framework, persistence, queue, and provider implementations remain outside.

The package is partially compliant in four areas:

1. The plan's versioned browser schemas imply useful validation parity, but
   runtime-only Zod refinements disappear from generated documents (SDK-004).
2. ADR-007 requires exactly one durable pre-dispatch marker; concurrency can
   cross the guard twice (SDK-001).
3. ADR-010 treats executor ABI as an exact executable reference, while manifest
   schema version 1 permits it to be absent (SDK-009).
4. The planned internal ownership directories are absent even though the flat
   files now contain several independent seams (SDK-006).

None of these contradictions justifies rewriting retained release data. Fixes
that change a manifest/schema/fingerprint must use additive compatibility
versions and preserve all supported historical releases.

## Findings and required changes

### SDK-001 — Concurrent ABI-2 marker calls bypass the duplicate guard

- **Severity:** P1.
- **Classification:** confirmed concurrency/correctness defect.
- **Status:** open.
- **Evidence:** `server.ts:903-916` checks `dispatchCount` before awaiting the
  supplied marker and increments afterward. A controlled `Promise.all` invoked
  the underlying marker twice; execution then failed with
  `dispatch_evidence_missing`.
- **Impact:** a malformed executor can prepare the same unsafe attempt for
  provider dispatch twice. The final error cannot roll back durable evidence or
  external work initiated by the callback. This violates ADR-007's exactly-one
  pre-dispatch contract.
- **Required change:** use a synchronous state machine such as
  `unused -> in_flight -> committed/failed`; transition to `in_flight` before
  awaiting. Every later call must fail as duplicate. Define explicitly whether
  a failed first marker can ever be retried; default fail-closed behavior should
  not permit a second call in the same invocation.
- **Required verification:** deterministic deferred-promise tests for two and
  many simultaneous calls, sequential duplicates, marker rejection, executor
  rejection during an in-flight marker, and exactly one committed successful
  call. Assert the underlying callback count and stable error code.

### SDK-002 — Own `__proto__` JSON keys corrupt canonical copies and releases

- **Severity:** P1.
- **Classification:** confirmed security/data-integrity defect.
- **Status:** open.
- **Evidence:** `server.ts:518,549,566-568` and `release.ts:385-395` construct
  `{}` and assign attacker-controlled keys. Parsed JSON with own `__proto__` was
  admitted; canonicalization lost the own key and changed the result prototype.
  A JSON Schema with `properties.__proto__` produced a frozen release that
  `parseRegistryRelease` rejected.
- **Impact:** valid node JSON can be silently changed; schema fingerprints can
  describe data different from the returned release; unexpected inherited
  properties can enter downstream code. This is local prototype mutation rather
  than demonstrated global `Object.prototype` pollution, but it is still a
  trust-boundary failure.
- **Required change:** use null-prototype records or define own data properties
  explicitly in every canonical/deep-copy path. Centralize safe object creation
  so release and server implementations cannot diverge.
- **Required verification:** root/nested hostile-key fixtures across predicate,
  canonicalizer, schema generation, release create/parse round trip,
  fingerprint stability, registry request, and executor output. Prove own keys,
  prototypes, descriptors, and JSON text are exact.

### SDK-003 — Browser admission and server canonicalization disagree on arrays

- **Severity:** P2.
- **Classification:** confirmed contract defect.
- **Status:** open.
- **Evidence:** `release.ts:177-187` rejects arrays whose enumerable keys are
  not exactly their dense indices. `server.ts:519-521,569-571` synthesizes only
  index keys. An array with enumerable `extra` was rejected by
  `isBoundedNodeJson` but canonicalized to `[]` without error.
- **Impact:** two public definitions of “bounded node JSON” disagree, and the
  server silently truncates data instead of rejecting it.
- **Required change:** share one traversal/admission kernel or duplicate the
  exact dense-array key check before copying. Reject rather than discard all
  non-index own properties.
- **Required verification:** dense, sparse, non-enumerable, symbol, extra-key,
  accessor, length-boundary, and nested arrays return identical admission
  decisions from browser schema and server canonicalizer.

### SDK-004 — Generated schema equality does not prove runtime/browser parity

- **Severity:** P2.
- **Classification:** confirmed contract/design gap.
- **Status:** open.
- **Evidence:** `release.ts:283-288` uses `z.toJSONSchema`; custom refinements
  disappear. `server.ts:642-655` compares the manifest with the same generated
  projection. A refined string rejected `denied` at runtime while its document
  described every string as valid. Real node schemas use runtime refinements.
- **Impact:** browser validation, documentation, and mapping assistance can
  accept values later rejected by publication/execution. The registry check's
  wording overstates what it proves.
- **Required change:** define a versioned schema-projection policy. Require
  explicit representable JSON Schema/extension metadata for browser-relevant
  refinements, record runtime-only semantics, and test shared examples through
  both validators. Rename checks/docs to “projection match” unless semantic
  parity is actually proved.
- **Required verification:** inventory every current refinement and transform;
  give each an equivalent document constraint or explicit runtime-only record;
  run golden valid/invalid fixtures in browser JSON Schema validation and Zod.

### SDK-005 — Definition schemas and executor types are disconnected

- **Severity:** P2.
- **Classification:** maintainability/type-safety improvement.
- **Status:** open.
- **Evidence:** `NodeDefinitionRegistration` stores non-generic `ZodType`s;
  `NodeExecutorRegistration.execute` accepts unknown values. The unused
  `TypedExecutorRegistration.__types` phantom field connects nothing, and
  `defineNodeExecutor` has zero callers. All three provider executors parse
  config/input after registry parsing.
- **Impact:** schema/executor mismatches are discovered at runtime, provider
  execution pays duplicate validation, and an exported abstraction adds public
  API without leverage.
- **Required change:** design one typed registration/bundle that owns a
  manifest, its config/input/output schemas, and its handler, then derives the
  untyped heterogeneous registry representation at one boundary. The registry
  should parse once and hand the correctly typed value to the paired handler.
  If that cannot be done clearly, delete the unused helper/types and document
  intentional executor-side parsing.
- **Required verification:** migrate at least two genuinely different core and
  provider nodes first; prove output/fingerprint identity and one parse per
  request; then migrate all registrations. Type tests must reject deliberately
  mismatched schemas/handlers.

### SDK-006 — Distinct owners are concentrated in two low-locality files

- **Severity:** P2.
- **Classification:** maintainability/plan-alignment improvement.
- **Status:** open.
- **Evidence:** `release.ts` is 845 lines and `server.ts` is 953 lines. Each
  contains multiple independent responsibilities listed in the architecture
  section. The plan anticipated domain directories; complexity ratchets only
  prevent worsening and do not improve navigation.
- **Impact:** unrelated changes collide, reviews must reload large contexts,
  security-boundary helpers are harder to test independently, and future node
  SDK growth will deepen coupling.
- **Required change:** split by the concrete internal seams proposed above,
  retaining the existing three public export paths. Do not split the SHA round
  function or the cohesive registry validation loop merely for line targets.
- **Required verification:** characterize the public export inventory,
  declaration files, schema documents, fingerprints, errors, catalogs, and
  execution results before moving code. Browser import and package-contract
  tests must remain green.

### SDK-007 — Foundational-package coverage is measured nowhere in CI

- **Severity:** P2.
- **Classification:** continuous-control gap.
- **Status:** open.
- **Evidence:** the package has no `test:coverage` script and is absent from root
  `test:coverage`. Ad hoc coverage was 88.29% statements, 75.41% branches,
  95.65% functions, and 89.57% lines. The missing concurrency/hostile-key cases
  passed every existing CI test.
- **Impact:** regressions at release, canonicalization, and dispatch boundaries
  can merge while mandatory coverage remains green.
- **Required change:** add focused tests first, then a package coverage command
  with justified thresholds and durable review of unreachable environment
  branches. Add SHA differential vectors without coupling production browser
  code to Node crypto.
- **Required verification:** lowering exercised risk branches fails the local
  and GitHub gate; no retry-masked flakes; the server-only branch is explicitly
  excluded/reviewed rather than faked.

### SDK-008 — Public JSON boundary is not exception-total and custom limits are unchecked

- **Severity:** P3.
- **Classification:** robustness improvement.
- **Status:** open.
- **Evidence:** proxy introspection errors escape from `isBoundedNodeJson`, Zod
  `safeParse`, and `canonicalizeBoundedJson`; `NaN` custom limits accepted an
  empty object. Byte size is checked after allocating the full canonical copy
  and serialized string.
- **Impact:** unusual in-process values can bypass the promised stable error
  taxonomy, and misuse of the public testing/custom-limits API produces
  surprising behavior. Very large scalar data can amplify peak memory before
  rejection.
- **Required change:** validate limits as positive safe integers; catch
  introspection/stringification failures and normalize them to false or
  `InvalidBoundedJsonError`; account UTF-8 bytes incrementally where practical.
- **Required verification:** trap every reflective operation with proxies,
  invalid limits (`NaN`, infinity, fractions, zero, negative), and large scalar
  boundaries without leaking arbitrary exceptions.

### SDK-009 — Compatibility-critical executor ABI is optional in manifest V1

- **Severity:** P3.
- **Classification:** contract precision improvement.
- **Status:** open.
- **Evidence:** `NodeManifest.executorAbi` and `nodeManifestSchema.executorAbi`
  are optional. Edge/registry checks compare ABI only when supplied. Core ABI-1
  manifests rely on the executor edge alone; later manifests pin it explicitly.
- **Impact:** browser/executable metadata can omit a field ADR-010 describes as
  exact compatibility data. Runtime remains protected by the executor manifest,
  so this is precision debt rather than a current fallback bug.
- **Required change:** make ABI explicit in the next compatible manifest schema
  version and migration strategy. Do not mutate retained V1 fingerprints.
- **Required verification:** every new manifest pins ABI; old releases retain
  exact parse/fingerprint/execution behavior; envelope compilation never
  infers a different ABI.

### SDK-010 — Successor construction permits gapped and no-op epochs

- **Severity:** P3.
- **Classification:** auditability improvement.
- **Status:** open.
- **Evidence:** only `next.epoch > previous.epoch` is required. Epoch 1 advanced
  to 999 with identical behavior and fingerprint. Repository callers currently
  add exactly one.
- **Impact:** future callers can create misleading release history or omit
  expected intermediate audit positions without violating this helper.
- **Required change:** decide whether epochs are contiguous by contract. If yes,
  require `previous.epoch + 1` and reject unchanged successors. If gaps are
  intentionally allowed for imported histories, rename/document the helper and
  require explicit predecessor/audit evidence at activation.
- **Required verification:** contiguous, gap, no-op, lifecycle-only, additive,
  and imported-history tests align with the durable database activation model.

## Non-findings and rejected refactors

- `node-sdk` is not an unnecessary shared package. Moving these contracts into
  workflow-engine, node-catalog, nodes-core, integrations, API, or worker would
  invert dependencies or duplicate exact compatibility semantics.
- The browser/server split and explicit subpaths are correct; one giant root
  barrel containing executor code would be worse.
- Runtime release parsing plus local registration matching is necessary defense
  for rolling deployment and retained execution, not redundant validation.
- Staged releases being non-executable is intentional and tested. Preactivation
  catalog/readiness handling belongs above the executable registry.
- Exact identity maps and startup-time linear scans do not need caching,
  database indexes, dependency injection, or a registry class hierarchy at the
  current catalog size.
- Deep freezing compatibility releases is appropriate. SDK-002 requires safe
  copying, not removal of immutability.
- Schema documents and Zod runtime schemas are both necessary: one is portable
  metadata, the other executes server validation. SDK-004 requires honest
  parity controls, not deleting either representation.
- The synchronous SHA-256 implementation is justified under the current API.
  It passed differential boundary checks and should be retained unless the
  public fingerprint API becomes asynchronous.
- `createNodeRegistry` should not be fragmented into one-function wrapper
  modules. Extract validated-state construction and execution ownership only.
- Stable error subclasses are useful to worker policy and tests; replacing them
  with strings or a generic result everywhere would lose behavior.

## Recommended repair order

1. Fix SDK-001 and SDK-002 first, with deterministic regression tests; both sit
   on unsafe execution/compatibility trust boundaries.
2. Unify JSON traversal and close SDK-003/SDK-008 while the hostile-key fixtures
   are fresh.
3. Define schema projection policy and audit all current refinements under
   SDK-004. Version any changed published manifest rather than editing retained
   identity behavior.
4. Add coverage enforcement and split tests by owner under SDK-007.
5. Design the typed registration seam with two real migrations, then resolve
   the dead helper and duplicate parsing in SDK-005.
6. Perform the internal module split in SDK-006 after behavior/export golden
   tests exist; avoid mixing it with semantic fixes.
7. Address SDK-009 and SDK-010 through explicit compatibility/ADR decisions,
   because both can affect retained release format or durable history policy.

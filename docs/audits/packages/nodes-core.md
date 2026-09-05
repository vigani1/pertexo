# `@pertexo/nodes-core` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 50 source files and all 1,388 physical source
  lines.
- **Test scope:** both package test files and all 478 physical test lines, plus
  node-catalog execution tests, API authoring/preview consumers, worker retained
  compatibility/recovery tests, database recurrence validation, package scripts,
  and CI execution.
- **Architecture sources:** the authoritative backend plan and ADRs 010, 014,
  and 017 through 021 and 026.
- **Audit status:** granularly certified for the pinned implementation tree.
- **Implementation status:** all eight repository-actionable findings are
  implemented and verified on the current branch. The original certification
  below remains the historical record for the pinned audit tree; the
  reconciliation record identifies the successor implementation evidence.

### Current remediation record

| ID | Previous status | Final status | Affected locations | Implementation and test evidence | Verification / commit |
| --- | --- | --- | --- | --- | --- |
| CORE-001 | Open confirmed defect | **Fixed** | Schedule validation/definition/executor, database trigger projection, engine trigger input, node-catalog release history | V2 introduced strict cron semantics. Metadata-complete V3 preserves the immutable V2 fingerprint while publishing its runtime-only semantics; database, engine, and catalog execute V1–V3. | Package/database/engine/catalog tests and typechecks; `5f9ce84`, `400dfe8`, `156f18f` |
| CORE-002 | Open confirmed contract defect | **Fixed** | Parallel/Merge definitions/executors, engine/worker consumers, node-catalog release history | V2 introduced strict settled-ledger contracts. Metadata-complete V3 preserves V2 identities while advertising runtime-only invariants; engine and worker apply configured ports and settled Merge input for V1–V3. | Package/engine/catalog tests and worker typecheck; `5f9ce84`, `156f18f` |
| CORE-003 | Open maintainability improvement | **Fixed** | `src/registrations.ts`, `src/server.ts`, retained-registry tests | Browser-safe definitions remain isolated as required by ADR-010. A server-only typed bundle joins definitions to executor implementations by exact identity, derives canonical executor order, and fails on duplicate, missing, or orphan implementations. | 55 tests, typecheck, build, ESLint, Knip; `3c98fa9` |
| CORE-004 | Open interface improvement | **Fixed** | Schedule V2/V3 definitions/executors, database and engine consumers, release history | V2/V3 advertise the strict trigger envelope; V3 adds explicit runtime-only cron metadata. V1/V2 fingerprints remain unchanged and all retained versions remain executable. | Trigger, projection, engine, and active-release execution tests; `5f9ce84`, `400dfe8`, `156f18f` |
| CORE-005 | Open immutability defect | **Fixed** | `merge/definition.ts`, `terminate/definition.ts`, package tests | The remaining mutable nested port array is frozen. A recursive test now checks every owned manifest tree, and the layout inventory covers all eleven node owners. | Package tests and fingerprints; `37594a4` |
| CORE-006 | Open continuous-control gap | **Fixed; continuous safeguard** | `package.json`, `vitest.coverage.config.ts`, root coverage cohort, `node-execution.test.ts`, retained-registry tests | Every one of 41 package functions executes locally through public SDK/server boundaries. Added exact failure tests for same-epoch drift, non-contiguous releases, and missing definition/executor implementations. Thresholds are now 96% statements, 80% branches, 100% functions, and 96% lines. | 55 tests; 96.83% statements, 81.81% branches, 100% functions, 96.78% lines; `19ae523`, `554502d` |
| CORE-007 | Open maintainability improvement | **Fixed** | Six owner-local test suites | Layout checks enumerate all eleven node directories. The former mixed suites are split into retained registry, trigger, data, orchestration, public execution, and package-contract owners; no global fixture or hidden assertion abstraction was introduced. | 6 files / 55 tests; clone gate remains 6 groups / 267 lines / 0.28%; `fd5fd10` |
| CORE-008 | Open cleanliness improvement | **Fixed** | `terminate/definition.ts`, repository imports | Removed the unused public alias and use the node-sdk `TERMINATES_RUN_CAPABILITY` identity directly. Repository-wide symbol search returns no `CORE_TERMINAL_CAPABILITY` occurrence outside this historical audit text. | Build/typecheck/export inventory; `37594a4` |

Current focused verification: `pnpm --filter @pertexo/nodes-core test`,
`typecheck`, `build`, package ESLint, `test:coverage`, `pnpm
dependencies:check`, and `pnpm duplication:check` all pass. The package now has
51 source files (1,719 physical lines) and six test files (932 physical lines).

The package is architecturally justified. It owns eleven provider-independent
node contracts and executors, keeps browser-safe manifests separate from
server-only execution, and gives node-catalog one reusable definition/executor
inventory. Per-node definition, validation, executor, and index files match the
plan and are small because they have narrow ownership—not because the code was
arbitrarily fragmented.

Most implementation code is clear and deliberately simple. Condition and
Switch select ports; Parallel and For Each publish deterministic declarations;
Merge, Wait, Manual, Set, Schedule, Webhook, and Terminate pass already-validated
data into engine-owned orchestration semantics. The package correctly avoids
putting durable scheduling, graph traversal, expression evaluation, provider
I/O, persistence, or tenancy logic inside node executors.

The main correctness gap is Schedule validation. Its browser/API Zod schema is
only a character/field-count regex and accepts cron text that the pinned
`cron-parser` seam rejects during later materialization. Merge's schema also
accepts states that ADR-019 explicitly says must never reach the executor. The
repeated manifest/registration boilerplate has already allowed one deep-freeze
inconsistency, and package-local tests do not directly execute eight of eleven
node implementations even though node-catalog tests mitigate that gap.

### Granular certification record

The package was recertified under the stricter component-audit contract after
the initial audit. The reviewer read the complete contents of all 56 tracked
package files: 50 production files, 2 test files, `package.json`, both
TypeScript configurations, and the Vitest configuration. This included every
small per-node barrel as well as every definition, schema, refinement, manifest,
executor callback, registry branch, fixture, and test case. Browser/server
exports and direct node-catalog, API, and worker consumers were retraced.
Automated inventories supported, but did not replace, the content review.

Fresh recertification checks passed: typecheck, all 19 tests, build, and package
ESLint. No additional finding was discovered. CORE-001 through CORE-008 remain
the complete known finding set for the pinned implementation. Certification
describes review coverage, not implementation completion; the confirmed
contract and immutability defects below remain actionable.

## Evidence collected

The review used full-file reading, all export/internal-callable inventory,
repository-wide symbol/import searches, consumer tracing, plan/ADR comparison,
TypeScript compilation, package build, ESLint, all package tests, ad hoc V8
coverage, runtime schema counterexamples, a recursive freeze inspection, and
comparison against the actual pinned database recurrence parser.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/nodes-core typecheck` | Passed |
| `pnpm --filter @pertexo/nodes-core test` | 2 files and 19 tests passed |
| `pnpm --filter @pertexo/nodes-core build` | Passed |
| `pnpm exec eslint packages/nodes-core` | Passed |
| Ad hoc package-source V8 coverage | 84.76% statements, 62.50% branches, 57.14% functions |
| Schedule counterexamples | three invalid expressions accepted by the node schema and rejected by the database parser |
| Merge counterexamples | empty, pending, selected-skipped, selected-missing, and duplicate-selected ledgers all accepted |
| Manifest freeze inspection | 10 manifests deeply frozen; `CORE_MERGE_MANIFEST.ports.outputs` mutable |

The headline Vitest report also included imported `node-sdk` source and therefore
reported 76.77% statements, 62.05% branches, 71.32% functions, and 77.99% lines.
The package-only figures above were calculated from the same coverage JSON by
filtering to `packages/nodes-core/src`. They are measurements, not CI thresholds.

## Architecture and ownership

### Module and directory shape

Each node has four files:

```text
<node>/definition.ts   immutable identity and browser manifest
<node>/validation.ts   executable Zod schemas and derived types
<node>/executor.ts     server-only registration and execution behavior
<node>/index.ts        browser-safe definition/validation export
```

The root browser entry exports manifests, policies, schemas, and compatibility
history. The `./server` entry loads the Node guard first, registers all executor
implementations, and exposes reduced registry construction. `definitions.ts`
joins every manifest to its executable Zod schemas; `registry.ts` owns the
retained three-node epoch-1 release and its lifecycle-only epoch-2 successor.

This is a good deep-module arrangement. Browser/catalog callers need only
immutable descriptive contracts; server callers need one registry factory.
Zod parsing, canonical JSON, release compatibility, output validation, and
terminal-capability interpretation remain hidden in `node-sdk`. Later release
history belongs to `node-catalog`, while this package owns the actual core node
implementations.

### Dependency direction

The package depends only on `node-sdk` and Zod. It imports no application,
database, queue, workflow-engine, Nest, Redis, or provider code. Its browser
entry never imports `./server`; the server path is explicitly unavailable to
browser resolution and guarded before implementation imports. There is no
internal cycle.

API and worker depend on the package primarily for retained compatibility
fixtures. `node-catalog` is the only production composition consumer: it imports
browser definitions from the root and executors from `./server`, then builds
additive staged/active releases. This direction matches ADR-001 and the plan's
node package shape.

### Correct ownership of orchestration semantics

The thin executors are intentional:

- Condition and Switch turn already-mapped values into stable selected ports.
- Parallel returns the configured ordered branch IDs; workflow-engine owns
  scoped admission and concurrency.
- Merge returns the engine-built durable ledger; workflow-engine owns settlement
  and canonical selection.
- For Each returns the bounded source collection and count; workflow-engine owns
  body expansion, budgets, and iteration identity.
- Wait returns the value; PostgreSQL/engine own durable suspension and resume.
- Schedule and Webhook return accepted trigger input; database/API own trigger
  materialization and ingress.
- Set receives an already-resolved mapping; expression evaluation stays in the
  pinned engine policy.
- Terminate returns the value; `node-sdk` interprets the immutable terminal
  capability.

Moving those durable behaviors into these executors would duplicate state
machines and violate recovery guarantees. Their apparent simplicity is a sign
of a correct seam, not missing application logic.

## Complete production-code review

### Root composition files

#### `src/policies.ts`

The two frozen policy references are exact finite compatibility identities.
Keeping them here makes every manifest/executor use the same objects and avoids
string/version drift. They are data, not a premature policy service.

#### `src/definitions.ts`

`CORE_NODE_DEFINITION_REGISTRATIONS` provides all eleven manifest/schema joins
required by `node-sdk`. Every registration is frozen and uses the exact per-node
schema constants. It is exhaustive today because node-catalog construction
would fail when a release contains an unimplemented definition.

The file contains 68 import lines and eleven nearly identical registration
objects. That repetition is reviewable at this scale but is one of three
parallel inventories: per-node manifests, definition registrations, and server
executor registrations. Their completeness is not expressed by one typed
source (CORE-003).

#### `src/registry.ts`

The epoch-1 release contains exactly Manual, Set, and Terminate with the two
pinned policies. The epoch-2 successor changes Manual lifecycle only and uses
the SDK's compatibility constructor, preserving immutable identity/schema/
executor data. This retained baseline is actively used by API/worker recovery
tests and is not dead legacy code.

Core epochs 1 and 2 already have independent durable fixture/database evidence;
the missing golden-fingerprint finding in the node-catalog audit applies to
platform-added epochs 3 through 24, not these two.

#### `src/server.ts`

`CORE_NODE_EXECUTOR_REGISTRATIONS` lists every core executor. `identityToken`
uses NUL separation and is duplicated privately in node-catalog; the helper is
small and keeping package ownership avoids a public low-value utility.

`CoreNodeRegistry` deliberately projects only compatibility, historical
catalog, dispatch mode, and execute. `createCoreNodeRegistryForRelease` parses
untrusted releases, accepts only the baseline or exact successor, joins exact
definition/executor implementations, and delegates all schema/compatibility
checks to `node-sdk`. Missing implementations fail closed.

Branches for same-epoch fingerprint mismatch, changed successor, and missing
definition/executor are not directly covered by package tests. The function is
cohesive and does not need splitting; its map construction is clearer local than
a generic registry-builder abstraction.

#### `src/index.ts` and `src/server-only.ts`

The root wildcard exports are broad but deliberate: node-catalog imports exact
node identities/manifests and browser consumers need schemas. Executor modules
are excluded from every per-node index, so the wildcard does not leak runtime
implementation. The Node guard is minimal and correctly precedes server imports.

`CORE_TERMINAL_CAPABILITY` is an unused exported alias for the node-sdk constant
and provides almost no abstraction leverage (CORE-008). `.js` specifiers are
correct NodeNext output paths.

### Trigger/pass-through nodes

#### Manual

Manual has strict empty config, arbitrary bounded JSON input/output, no inputs,
one `out` port, no connections/credentials, and safe CPU execution. Returning
the run input unchanged is correct. Canonical copying/sorting and bounds are
enforced by `node-sdk`, not duplicated here.

#### Webhook

Webhook correctly has strict empty graph config because endpoint keys, signing
secrets, state, and health belong to materialized trigger persistence under
ADR-026. Arbitrary bounded JSON input/output matches the authenticated webhook
payload contract. No secret or endpoint capability leaks into the manifest.

#### Schedule

The interval branch correctly accepts 1 through 43,200 integer minutes and the
misfire enum defaults to `catch_up_once`. The timezone refinement uses the
runtime's canonical `Intl.supportedValuesOf('timeZone')` set and correctly
rejects aliases under the pinned Node runtime.

The cron expression regex checks only length, characters, and exactly five
single-space-separated fields. It permits invalid values, zero steps, `?`, and
other syntax rejected by the actual strict parser (CORE-001). It also means the
generated JSON Schema contains only this permissive regex, while the timezone
Zod refinement is absent from that document (CORE-002).

Schedule input/output use generic bounded JSON even though the production
schedule acceptance envelope has known `schemaVersion`, `triggerId`, `nodeId`,
and `scheduledAt` fields. This prevents the catalog from advertising useful
trigger output shape and is recorded as CORE-004 rather than assumed to be a
correctness defect.

#### Wait

The exact 1-to-2,592,000-second bound, strict config, suspension capability,
ports, policies, and pass-through result match ADR-021. Sleeping is correctly
absent. Preview refusal and durable resume live in application/engine/database
seams.

### Data/control nodes

#### Set and Terminate

Both require bounded JSON records rather than any JSON value. Set pins both
bounded-JSON and restricted-JSONata policies and passes an already-resolved
record. Terminate has no output ports, pins the terminal capability, and returns
the terminal value for `node-sdk` to convert into `terminal_success`. There is
no duplicated mapping or termination state machine.

#### Condition

The schemas exactly match ADR-017. The executor uses strict boolean selection
and returns only `true` or `false`; registry validation makes its local cast
safe. Expression evaluation and branch reachability remain outside the node.

#### Switch

The sixteen stable case ports, default port, scalar limit, strict ordered case
config, unique case IDs, and first-`===`-match semantics match ADR-018. Duplicate
match values correctly remain legal because first-match precedence is part of
the contract. JSON-number validation prevents NaN/non-finite values before the
executor.

#### Parallel

Config enforces two-to-sixteen unique branch IDs and concurrency between one
and the selected branch count. The executor preserves configured order. The
output schema bounds the array but does not independently require unique IDs or
equality with config; a future executor mistake can pass output validation with
duplicates (CORE-002).

#### Merge

The config correctly limits policy kinds/count and uses a bounded stable
Parallel node ID. Input keys are limited to the exact sixteen branch ports.
However, the schema accepts pending ledgers, empty/incomplete ledgers, duplicate
selected IDs, selected IDs missing from the ledger, and skipped/failed IDs as
selected. Those contradict the complete settled canonical input promised by
ADR-019 (CORE-002). The current engine independently constructs and validates
canonical join state, so this is defense/contract drift rather than evidence
that serving runs currently produce bad joins.

`CORE_MERGE_MANIFEST.ports.outputs` is the sole mutable nested collection among
all eleven exported manifests (CORE-005).

#### For Each

The source collection is capped at 1,000 items and additionally checked against
the bounded JSON policy. Output requires the same collection plus an equal
iteration count. The executor preserves items and derives count. Body topology,
budgets, nested identity, scheduling, and aggregation decisions correctly remain
in workflow-model/engine.

## TypeScript, naming, imports, and control flow

- Naming is systematic and searchable: every node exports definition,
  executor, manifest, config/input/output schema, and any bounded constants.
- Imports respect browser/server ownership. `import type` is used correctly and
  no server dependency leaks through a browser barrel.
- Strict schemas reject unknown object keys. Discriminated unions model Schedule
  and Merge policy without boolean-flag ambiguity.
- Executor casts exist because `NodeExecutorRegistration` erases config/input
  generics. They are safe only through `createNodeRegistry`, which parses before
  dispatch. `node-sdk` exposes `defineNodeExecutor`, but adopting it naively
  would parse twice under the registry and is not automatically an improvement.
  CORE-003 should solve metadata/type locality deliberately rather than merely
  replacing casts.
- Control flow is straight-line. There is no deeply nested function, async
  leak, swallowed error, retry loop, hidden I/O, singleton mutation, `any`, or
  suppression comment in production code.
- Comments are sparse and useful. Webhook's state-ownership comment and the
  retained-successor explanation record non-obvious architectural intent.

## Reuse, repetition, and file structure

The per-node directories are appropriate. Definition and validation are
browser-owned while executor is server-only, so combining each node into one
file would break the export seam. The two-line indexes are intentional barrels,
not pointless modules.

There is genuine boilerplate inside definition and executor objects. Eleven
manifests repeat schema generation, empty requirement arrays, identity fields,
ABI/lifecycle/retry/resource data, and freezing. Eleven executors then repeat
ABI, definition, identity, lifecycle, and policy references already present in
their manifests. Separate root arrays repeat membership a third time. The
variation is declarative; a small internal typed constructor/bundle could remove
lines and enforce invariants while keeping each node's explicit values visible
(CORE-003). A generic plugin framework, decorator system, or code generator
would be disproportionate.

No executor behavior itself is meaningfully duplicated beyond intentional
pass-through. A shared `passThroughExecutor` could reduce a handful of lines but
would obscure which versioned registration owns which policies and capability;
it is not recommended unless introduced as part of the stronger typed bundle.

## Test usefulness and CI assessment

### Package tests

The 19 tests are substantive for the retained baseline and schema declarations.
They prove exact epoch-1 identities/policies, lifecycle-only successor binding,
rejection of epoch 3, reduced registry surface, Manual/Set/Terminate behavior,
canonical non-mutation, record bounds, terminal result, pre-abort behavior,
strict config, Switch/Parallel/Merge/For Each/Wait config basics, package export
separation, and server-first guarding.

Important gaps:

- package-local tests never invoke Condition, Switch, Parallel, Merge, For Each,
  Wait, Webhook, or Schedule executors; node-catalog currently supplies those
  behavior tests, but local coverage reports seven executor functions at 0%;
- invalid cron semantics are not compared with the pinned recurrence parser;
- Merge tests check only config, not its input/output invariants;
- Parallel output uniqueness is untested;
- same-epoch mismatch, changed successor, missing definition, and missing
  executor registry paths are untested;
- the layout test enumerates only Manual, Schedule, Set, Terminate, and Webhook,
  omitting six per-node directories; and
- the 414-line `core.test.ts` mixes retained compatibility, execution, and five
  orchestration contracts. It is still navigable, but its ownership should be
  split before additional core nodes grow it further (CORE-007).

Node-catalog tests materially mitigate execution gaps: they execute all eight
later core nodes under their exact additive release and prove staged/active
selection. Worker/database integration tests prove branch, loop, wait, webhook,
and schedule recovery semantics. Those are valuable integration guarantees, but
they do not make package-local regression coverage enforceable.

### CI and coverage

GitHub Actions builds, lints, typechecks, and runs all 19 package tests in the
core matrix, then separately runs node-catalog and the higher-level service
tests. The package has no `test:coverage` script and is absent from the root
critical coverage command. Its 57.14% package function coverage can regress
without failing CI (CORE-006).

Tests are not ceremonial: they assert compatibility and executor results rather
than snapshots of source text. The weakness is ownership/distribution, not lack
of meaningful higher-level testing.

## Findings and required changes

### CORE-001 — Schedule's published node validator accepts cron expressions the runtime rejects

- **Severity:** P1.
- **Classification:** confirmed defect.
- **Status:** fixed by additive V2/V3 contracts and consumer integration
  (`5f9ce84`, `400dfe8`, `156f18f`).
- **Evidence:** `schedule/validation.ts:9-16` uses a character regex. Direct
  comparison showed `99 99 99 99 99`, `*/0 * * * *`, and `? ? ? ? ?` all pass
  `CORE_SCHEDULE_CONFIG_SCHEMA` for `America/New_York`, while
  `parseScheduleRecurrence` rejects each through pinned `cron-parser` 5.10.0.
- **Impact:** workflow authoring/publication can accept a Schedule graph that
  later fails materialization/reconciliation. The user sees a valid published
  node that can never schedule, violating the plan rule that a node is not
  publishable until its contract is complete.
- **Required change:** make node config validation and database recurrence
  validation use one exact strict grammar/fixture contract. If dependency rules
  prevent sharing implementation, share a golden acceptance/rejection corpus
  and run the pinned parser at the authoritative publication seam. Do not try to
  reproduce cron semantics with a permissive regex alone.
- **Required verification:** table-drive valid edges and invalid field ranges,
  zero steps, reversed/out-of-range ranges, unsupported tokens, spacing, field
  count, timezone aliases, and canonical zones through node resolution,
  publication, materialization, and recurrence parsing. Every layer must agree.

### CORE-002 — Structured-node schemas understate durable Parallel/Merge invariants

- **Severity:** P2.
- **Classification:** confirmed contract defect; current engine integration is independently fail-closed.
- **Status:** fixed by additive V2/V3 contracts and engine/worker integration
  (`5f9ce84`, `156f18f`).
- **Evidence:** `merge/validation.ts:15-50` allows `pending`, optional arbitrary
  outputs, partial ledgers, and any bounded selected array. Direct schema calls
  accepted empty, pending, selected-skipped, selected-not-in-ledger, and
  duplicate selections. `parallel/validation.ts:53-60` accepted duplicate output
  branch IDs. ADR-019 requires a complete settled keyed ledger and canonical
  selected set.
- **Impact:** the versioned node schema cannot detect a future engine/adapter
  regression before the executor persists/returns a structurally plausible but
  semantically impossible result. Catalog consumers also receive a weaker
  contract than the ADR describes.
- **Required change:** define a settled ledger-entry schema, enforce unique
  selected IDs, require selected entries to exist and have an eligible settled
  disposition, and reject an empty ledger. Cross-check config/declared branch
  equality in the executor or a typed validation helper where both values are
  available. Require unique Parallel output and equality with configured IDs.
- **Required verification:** exhaustive disposition/selection matrix, missing
  and extra branches, duplicate IDs, canonical order, all/any/count outcomes,
  and characterization of every valid engine-generated ledger.

### CORE-003 — Node metadata is maintained in three parallel representations

- **Severity:** P2.
- **Classification:** maintainability improvement.
- **Status:** fixed (`3c98fa9`).
- **Evidence:** each definition repeats identity/ABI/policy/lifecycle metadata;
  each executor repeats it again; `definitions.ts` and `server.ts` manually list
  all implementations separately. The package has 68 lines of registration
  imports and eleven repeated registration records. CORE-005 demonstrates one
  invariant already missed by manual construction.
- **Impact:** adding/versioning a node requires synchronized edits across files
  that TypeScript does not derive from one owner. Registry creation fails closed
  for some drift, but failures surface late and boilerplate discourages complete
  review.
- **Required change:** introduce one small internal typed node bundle/constructor
  that accepts explicit identity, ports, policies, schemas, and execute behavior,
  derives definition and executor registrations, and recursively freezes owned
  metadata. Keep per-node directories and named exported constants; avoid
  decorators, runtime discovery, or opaque code generation.
- **Required verification:** characterize all current manifest JSON and release
  fingerprints first. The refactor must keep byte-identical schema documents,
  fingerprints, identities, port order, policy references, and execution output;
  exhaustive membership tests must cover all eleven nodes.

### CORE-004 — Schedule's manifest does not describe its known trigger envelope

- **Severity:** P2.
- **Classification:** interface/product ergonomics improvement.
- **Status:** fixed by additive V2/V3 contracts and consumer integration
  (`5f9ce84`, `400dfe8`, `156f18f`).
- **Evidence:** Schedule input/output use `boundedNodeJsonSchema`. Production
  schedule acceptance persists a strict versioned envelope containing
  `schemaVersion`, `triggerId`, `nodeId`, and `scheduledAt`. Catalog tests use an
  ad hoc smaller `{ scheduledAt }` value because the node contract promises no
  fields.
- **Impact:** editors, mapping assistance, generated documentation, and static
  workflow validation cannot advertise or type-check the actual Schedule event
  fields. Users must know runtime shape out of band.
- **Required change:** decide and document the stable public Schedule trigger
  payload. If the internal persistence envelope is not the product contract,
  project it to a smaller versioned public object. Give Schedule exact strict
  input/output schemas while preserving bounded JSON.
- **Required verification:** direct scanner-to-run-to-Schedule integration proves
  the exact advertised payload and retained releases keep their prior schema.

### CORE-005 — One exported manifest contains a mutable nested port array

- **Severity:** P3.
- **Classification:** confirmed defect with low current exploitability.
- **Status:** fixed (`37594a4`).
- **Evidence:** `merge/definition.ts:28-31` freezes the ports object but supplies
  mutable `outputs: ['out']`. Recursive inspection found this as the only
  mutable nested collection across eleven manifests.
- **Impact:** JavaScript or an unsafe cast can mutate exported compatibility
  metadata in process, creating order-dependent catalog behavior. It also shows
  manual deep-freeze discipline is fallible.
- **Required change:** freeze/canonicalize all owned manifest trees through one
  constructor or explicitly freeze this output array. Do not rely only on
  readonly TypeScript types.
- **Required verification:** recursive immutability test over every exported
  manifest and mutation attempt; confirm release fingerprints stay unchanged.

### CORE-006 — Core-node implementation coverage is not enforced

- **Severity:** P2.
- **Classification:** continuous-control gap.
- **Status:** fixed; retained as a continuous coverage safeguard (`19ae523`, `554502d`).
- **Evidence:** there is no package `test:coverage` script or root cohort.
  Package-only ad hoc coverage is 84.76% statements, 62.50% branches, and 57.14%
  functions; seven later executor functions have 0% local execution coverage.
- **Impact:** a core schema/executor/registry failure can regress while mandatory
  coverage remains green, especially if a node-catalog test is later moved or
  narrowed.
- **Required change:** add direct table-driven tests for every node and registry
  failure seam, then enforce justified package thresholds. Count higher-level
  tests as integration evidence, not as an invisible substitute for local
  ownership.
- **Required verification:** threshold regression fails locally/CI; all eleven
  executors and custom schema refinements execute; environment-impossible server
  guard remains explicitly reviewed.

### CORE-007 — Test ownership and layout checks have already drifted

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed (`37594a4`, `fd5fd10`).
- **Evidence:** `package-contract.test.ts` checks definition/validation/executor
  files for only five of eleven nodes. `core.test.ts` combines retained release,
  registry errors, base execution, and unrelated orchestration schemas in 414
  lines.
- **Impact:** the structural convention is not exhaustively guarded and finding
  one node's contract requires navigating unrelated compatibility fixtures.
- **Required change:** derive the layout assertion from the complete expected
  node list and split tests by retained registry, trigger nodes, data nodes, and
  orchestration nodes. Extract only genuinely shared execution fixtures.
- **Required verification:** assertion count/behavior remains, every node is
  listed exactly once, and clone detection does not regress.

### CORE-008 — `CORE_TERMINAL_CAPABILITY` is a zero-leverage public alias

- **Severity:** P3.
- **Classification:** code-cleanliness improvement.
- **Status:** fixed (`37594a4`).
- **Evidence:** the symbol aliases `TERMINATES_RUN_CAPABILITY`, is used only by
  the Terminate manifest in this package, and has no external consumer. The root
  wildcard makes it public anyway.
- **Impact:** the public vocabulary suggests a distinct core concept/version
  where none exists and adds one more name consumers may couple to.
- **Required change:** use the node-sdk capability directly and stop exporting
  the alias in the next compatible cleanup, unless a documented consumer-facing
  distinction is intended. Because packages are private, coordinate workspace
  typecheck rather than adding deprecation machinery by default.
- **Required verification:** repository-wide symbol search, build, and package
  export inventory remain green.

## Non-findings and rejected refactors

- `nodes-core` is necessary. Putting these nodes in API, worker, engine, or
  node-catalog would mix catalog metadata with implementation or duplicate code.
- Fifty files are not over-fragmentation here. Definition/validation must remain
  browser-safe while executor must remain server-only, and each node is an
  independent versioning owner.
- Thin pass-through executors are correct. Wait must not sleep, Schedule must not
  calculate recurrence, Merge must not settle joins, and For Each must not run
  its body.
- `createCoreNodeRegistryForRelease` is retained compatibility infrastructure
  used by recovery tests, not obsolete production clutter.
- Fixed 16-port tuples are appropriate immutable bounded topology, not data that
  should be dynamically generated at runtime.
- Object freezing is appropriate for published manifests/releases. CORE-005 is
  about consistency, not an argument to remove freezes.
- Linear maps and short array construction happen at startup over eleven nodes;
  caching or indexing abstractions are unwarranted.
- JSONata policy belongs in compatibility metadata even though expression
  execution occurs elsewhere.
- Cross-package node-catalog tests are useful end-to-end compatibility tests;
  CORE-006 asks for local ownership as well, not duplication of engine recovery
  matrices.

## Recommended repair order

1. Fix CORE-001 before accepting new Schedule publications; characterize the
   currently published epoch-24 fingerprint before changing its schema and use
   an additive definition/release if compatibility identity changes.
2. Characterize valid durable join outputs, then tighten CORE-002 without
   rejecting legitimate engine state.
3. Add complete local tests and coverage enforcement under CORE-006/CORE-007.
4. Introduce the small typed bundle in CORE-003 only after golden manifest and
   release evidence exists; close CORE-005 through that work.
5. Decide the public Schedule event contract in CORE-004 as a versioned product
   choice, not a casual schema edit.
6. Remove or justify the unused alias in CORE-008.

Any manifest/schema change must follow ADR-010 compatibility rules. Do not edit
an already-published identity in place merely to make validation stricter; add
the required successor definition/release and retain old execution behavior.

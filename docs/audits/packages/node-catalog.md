# `@pertexo/node-catalog` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** every line of all 5 source files: 987 lines total.
- **Test scope:** every line of both package test files: 1,010 lines total;
  direct API/worker consumers, retained-workflow fixtures, compatibility
  integration suites, package configuration, and CI execution were also traced.
- **Architecture sources:** the authoritative backend plan and ADR-010.
- **Audit status:** granularly certified for the pinned implementation tree.
- **Implementation status:** all six repository-controlled findings are fixed.

The package implements the correct architectural role. It is the platform-owned
composition module between browser-safe node metadata, immutable compatibility
releases, and server-only executors. Its root/server export split is sound, its
dependency direction is correct, and current release behavior is well tested.

Immutable history now keeps explicit named releases while sharing one private
staging/activation implementation and one cohort configuration. Package-owned
golden fingerprints independently pin every retained release. Tests are split
by release/cohort history, definition resolution, server composition, and
package-contract ownership.

The 766-line `registry.ts` is therefore a maintainability finding because it
contains parallel sources of truth, not because 766 is inherently too many
lines. `server.ts` is a cohesive composition module and should not be split just
to reduce its size.

### Granular certification record

The package was recertified under the stricter component-audit contract after
the initial audit. The reviewer read the complete contents of all 11 tracked
package files: 5 production files, 2 test files, `package.json`, both TypeScript
configurations, and the Vitest configuration. The pass inspected every export,
internal function, callback, constructor path, test fixture, and test case; it
also retraced browser/server export separation and all repository consumers in
API and worker code. Automated inventory and symbol searches supported, but did
not replace, the content review.

Fresh remediation checks passed: typecheck, all 19 tests, build, and package
ESLint. No additional finding was discovered. NC-001 through NC-006 remain the
complete known finding set for the pinned implementation. Certification refers
to review coverage, not implementation completion; the current disposition is
recorded below.

## Evidence collected

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/node-catalog typecheck` | Passed |
| `pnpm --filter @pertexo/node-catalog test` | 4 files and 19 tests passed |
| `pnpm --filter @pertexo/node-catalog build` | Passed |
| `pnpm exec eslint packages/node-catalog` | Passed |
| Enforced package V8 coverage | 96.69% statements/lines, 87.23% branches, 100% functions |
| Dependency/cycle inspection | One-way imports; no internal or workspace cycle found |
| Export/consumer tracing | Root used by API and worker; server entry used only by worker and tests |
| Compatibility evidence | Exact package-owned golden fingerprints pin all 30 retained releases |

Coverage is enforced by the package-owned configuration and root
`test:coverage` command.

## Architecture, module depth, and dependency direction

### Owned role

The package owns three distinct but related interfaces:

1. The browser-safe root exposes immutable release metadata, cohort selection,
   and schema/definition resolution.
2. The server entry composes the exact executor implementations for one
   supported executable release.
3. The internal definition-resolution seam joins a release manifest to its
   browser-safe Zod schemas without loading executor implementations.

This gives callers high leverage. API configuration and publication code learn
one cohort vocabulary; workers learn one registry factory; neither reconstructs
compatibility rules. Deleting the package would spread release-selection logic
across API and worker call sites, so the package earns its existence.

The workspace dependency direction is appropriate:

- `node-catalog` depends on stable contracts from `node-sdk`, browser-safe
  definitions from `nodes-core` and `integrations`, and their server entries only
  from its own server entry;
- API imports only the browser-safe root;
- worker imports the root plus `/server` when it needs execution; and
- workflow-engine does not import the catalog or provider implementations.

There is no circular source import. The root export map rejects the server entry
for browser resolution, and package-contract tests assert that the browser
source does not import provider/core server entries. A type-only import from
`@pertexo/node-sdk/server` supplies `NodeDefinitionRegistration`; it is erased
from browser output and does not load executor code.

### Plan and ADR fit

The three registry layers required by the plan and ADR-010 remain distinct:
manifest metadata is browser-safe, executor implementation is server-only, and
workflow instances live elsewhere. Releases use separate immutable definition,
executor, policy, epoch, and fingerprint identities. Staged executors are not
served, activation moves the exact executor to active, older executable history
is retained, unsupported releases fail closed, and workers resolve the exact
pinned release rather than “latest.”

Current epochs 1–24 are canonical and unique in the running code. The risk is
that their expected fingerprints are not independently pinned against future
source edits (NC-001), which weakens the ADR's immutability safeguard.

## Complete production-code assessment

### `src/definition-resolution.ts`

| Callable | Assessment |
| --- | --- |
| `platformIdentityToken` | Correct small identity helper. NUL separation avoids ambiguous concatenation and it is reused by definition and executor maps. |
| `parseSupportedPlatformRelease` | Parses the full untrusted release, verifies its canonical fingerprint through `node-sdk`, then checks epoch/fingerprint membership. It correctly returns the validated supplied release because equal identity plus canonical fingerprint implies equal projected content. Linear search across 24 releases is negligible. |
| `resolvePlatformNodeDefinitionForRelease` | Correctly requires both release membership and a local implementation, uses the release manifest with local schemas, and fails closed. Its `definitionInput` parameter is typed as already-valid although it immediately parses it; `unknown` would describe the runtime interface more honestly (NC-006). |

The local registration array is rebuilt and linearly searched for each
resolution. With fourteen definitions and request paths dominated by validation,
this is not a justified caching abstraction. A map becomes worthwhile only if
measurement or a materially larger catalog demonstrates need.

### `src/registry.ts`

This file owns the right behavior but expresses it through three parallel
representations:

- 22 exported staged/active release constants;
- 23 exported support arrays and a cohort tuple; and
- separate switches for support and serving release selection.

Each staged block repeats ABI extraction, manifest addition, executor addition,
policy handling, lifecycle, and predecessor/epoch wiring. Each activation block
repeats identity matching and lifecycle replacement. This is genuine structural
duplication: every new release must reproduce the same algorithm correctly, and
the variation is declarative data (manifest, predecessor, policies, epoch), not
behavior. NC-002 recommends deepening this into internal helpers or a typed
declarative history while retaining named public constants.

The later cohort functions are readable and exhaustive at compile time, but
support and serving mappings can drift because they are maintained separately.
The early releases calculate epochs as `previous.epoch + 1` while epochs 15–24
are literal. Immutable published identities should use one deliberate convention
and independent golden evidence; neither style alone prevents accidental
renumbering.

`platformExecutableRegistryHistory` correctly distinguishes executable retained
history from two-release readiness support. Its filtering by maximum epoch is
valid while history is additive and ordered, an invariant already required by
ADR-010 and tested. `platformServingReleaseRequiresHttpCapabilities` derives its
answer from actual executor lifecycle rather than duplicating a cohort list,
which is the better style.

### `src/server.ts`

| Callable/section | Assessment |
| --- | --- |
| `PlatformNodeRegistry` | A deliberately reduced interface over `NodeRegistry`; it hides registration internals while preserving compatibility, historical catalog, dispatch mode, and execution. This is a deep interface, not a pass-through smell. |
| `PlatformNodeRegistryDependencies` | Provider-specific optional adapters and telemetry are explicit and testable. The named fields are preferable to a generic untyped bag. |
| definition registration/map construction | Correctly joins only release-declared manifests to local schemas and fails closed when code is absent. Identity mapping avoids repeated nested search during construction. |
| provider executor construction | Correct dependencies and telemetry are threaded through. All HTTP, Slack, and email adapters are nevertheless created before the factory knows whether the selected release needs them (NC-003). |
| executor registration/map construction | Correctly maps exact release identities and reuses only the implementation's execute function while preserving the release manifest. Missing implementation fails closed. |
| returned registry projection | Freezes a small caller interface. No unnecessary wrapper method or mutable registry internals leak out. |

`createPlatformNodeRegistryForRelease` is cohesive composition code. Splitting
each map or provider into separate public factories would expose internal seams
and reduce locality. The useful improvement is lazy/selective internal adapter
construction, not more files or public types.

### `src/index.ts` and `src/server-only.ts`

The root barrel is explicit for definition resolution and intentionally exports
the declarative registry vocabulary. The wildcard registry export is broad but
deliberate because named historical constants are used by integration and
recovery fixtures. The package export map is the primary browser/server
enforcement. `server-only.ts` adds a cheap runtime defense for non-Node hosts;
its failing branch is naturally unexecutable in the Node unit environment and
does not need artificial coverage.

## Reuse, readability, and file structure

- `definition-resolution.ts`, `server.ts`, `index.ts`, and `server-only.ts` each
  have one clear reason to change.
- There is no dead production function, circular dependency, unsafe `any`,
  ignored promise, hidden global mutation, or generic utility dumping ground.
- Identity matching is correctly shared through `platformIdentityToken`.
- Server registry construction reuses `node-sdk` validation instead of copying
  schema/execution checks.
- The release file's repeated staged/active and cohort code should be shared
  internally because the repeated parts encode one invariant-bearing algorithm.
- The package test file combines release topology, every core/provider smoke,
  schema resolution, server composition, and telemetry in 969 lines. The tests
  are valuable, but ownership and navigation would improve if split by these
  behavioral interfaces (NC-004).

## Test usefulness and CI assessment

The 16 tests are substantive. They execute Webhook, Schedule, Email, Slack,
Wait, For Each, Merge, Parallel, Switch, Condition, Set, and HTTP behaviors;
verify staged/active serving; check exact epoch history and unique current
fingerprints; reject unsupported/staged releases; prove schema-only resolution;
thread provider telemetry; zero a credential buffer; and inspect the browser
export contract.

The tests therefore prove far more than object snapshots. They cross the same
registry interfaces used by API and worker. Real PostgreSQL compatibility tests
also compare process-supported releases with durable release state, while the
worker retains an immutable core workflow V2 fixture.

Important gaps remain:

- package tests assert fingerprint uniqueness but not the exact historical
  fingerprint of each release;
- mappings are checked in several long hand-written groups rather than through
  one exhaustive invariant over every `PLATFORM_RELEASE_COHORTS` value;
- default adapter construction is not tested for selectivity;
- missing definition and staged release failures are covered, but missing
  executor implementation uses no direct assertion; and
- this compatibility-critical package has no enforced coverage script or root
  critical-coverage cohort.

GitHub Actions runs the 16 tests in the core unit matrix. Higher-level API and
worker integration jobs exercise compatibility rollout and retained execution.
The ad hoc 86.09%/81.08% package measurement is not a CI threshold, so green CI
does not prevent future package coverage regression.

## Findings and required changes

### NC-001 — Historical platform release fingerprints are not independently pinned

- **Severity:** P1.
- **Classification:** maintainability improvement with durable-compatibility risk.
- **Status:** fixed in the repository by `fade038`.
- **Original evidence (audited tree):** `registry.ts` recomputes every platform release from currently
  imported manifests. Tests assert epochs and fingerprint uniqueness. Core
  epochs 1/2 have exact evidence in database migration/baseline and retained-V2
  fixtures, but the repository contains no exact expected fingerprint for the
  platform-added epochs 3–24.
- **Impact:** changing a retained manifest/schema/policy under an existing
  identity recomputes descendant fingerprints in the same module. Successor
  validation compares objects constructed from the same new source and cannot
  independently prove that yesterday's published identity stayed unchanged.
  Durable database readiness may eventually detect a mismatch, but local package
  CI should reject it first and explain which release changed.
- **Required change:** check in a canonical golden projection and exact
  fingerprint for every retained platform release. Updating it must be an
  explicit compatibility change with a new identity/release, never a casual
  snapshot refresh. Keep the existing runtime canonicalization checks.
- **Verification:** mutate one retained manifest field without a version bump and
  prove the package test fails against the old release fingerprint; prove a new
  additive release leaves every prior golden entry byte-identical.

### NC-002 — Release construction and cohort selection have parallel sources of truth

- **Severity:** P2.
- **Classification:** maintainability improvement.
- **Status:** fixed in the repository by `f881f8c` and `d003ed2`.
- **Implemented evidence (2026-09-05):** cohort support and serving
  selection now come from one typed `platformReleaseCohortConfig`; the exported
  cohort vocabulary is derived from that record. The prior two exhaustive
  switches were removed, while named support constants remain for compatibility
  and review. All staged/active pairs now use the same private transition
  helpers; the 30 golden fingerprints remain byte-identical.
- **Original evidence (audited tree):** `registry.ts:24-475` repeats staged/active creation for eleven
  nodes; lines 507–612 define support pairs; lines 641–689 and 707–754 separately
  map the same cohorts to support and serving releases.
- **Impact:** adding a node requires synchronized edits across construction,
  history, support, cohort vocabulary, support selection, serving selection, and
  tests. A locally plausible missed edit can select the wrong serving predecessor
  or readiness pair.
- **Required change:** introduce small internal `stageRelease` and
  `activateRelease` implementations, plus one typed cohort configuration record
  from which support and serving selection are derived. Preserve explicit epoch,
  manifest, policy, and named exported constants so historical review stays
  readable; do not hide history in clever metaprogramming or generate releases
  from mutable runtime discovery.
- **Verification:** characterize all existing epochs/fingerprints first, then
  prove byte-identical release projections, every cohort's support pair, serving
  epoch, executable-history maximum, and staged non-serving behavior.

### NC-003 — Server registry construction eagerly creates unused provider adapters

- **Severity:** P2.
- **Classification:** maintainability and startup-efficiency improvement.
- **Status:** fixed in the repository by `496230a`.
- **Original evidence (audited tree):** `server.ts:83-124` creates HTTP, Slack, and email executor
  adapters for every supported release, including core and early cohorts that do
  not contain those executors. Release filtering occurs afterward.
- **Impact:** registry construction does work and creates dependency graphs that
  the selected artifact cannot execute. As providers grow, startup cost and
  failure surface scale with the entire catalog instead of the serving release.
- **Required change:** index provider executor factories and instantiate only
  identities present in the parsed release. Keep the selection inside this
  module so callers still use one registry factory.
- **Verification:** injected factory spies prove core creates no provider
  adapter, HTTP activation creates only HTTP, and the latest cohort creates only
  its declared exact executors; execution behavior remains unchanged.

### NC-004 — One test file owns several independent behavioral interfaces

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed in the repository by `1d4cff9`.
- **Original evidence (audited tree):** `test/catalog.test.ts` is 969 lines and combines compatibility
  topology, schema resolution, core node execution, provider credential/runtime
  fixtures, telemetry, and server composition.
- **Impact:** finding the characterization for one interface requires navigating
  unrelated provider fixtures, and future additions will push one already broad
  test owner further. The concern is mixed reasons to change, not line count.
- **Required change:** split into release-history/cohort, definition-resolution,
  and server-registry composition tests. Extract only genuinely shared runtime
  fixture builders; do not duplicate provider packages' detailed behavior tests.
- **Verification:** the same assertions and test count remain green, clone
  detection does not regress, and no split file reaches the repository ceiling.

### NC-005 — Compatibility-critical package coverage is not enforced

- **Severity:** P2.
- **Classification:** continuous control gap.
- **Status:** fixed as a continuous repository control by `fade038`.
- **Original evidence (audited tree):** the package has no `test:coverage` script or coverage config and
  is absent from root critical coverage. Ad hoc branch coverage is 81.08%.
- **Impact:** historical selection or fail-closed branches can regress while all
  mandatory coverage checks pass.
- **Required change:** add justified package thresholds and include this package
  in the root critical coverage command after NC-001/NC-002 characterization is
  in place. Exclude only the environment-impossible server-only failure branch
  with an explicit review.
- **Verification:** threshold-failure test plus green root coverage/risk report.

### NC-006 — Definition resolution's interface understates its runtime validation role

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed in the repository by `496230a`.
- **Original evidence (audited tree):** `resolvePlatformNodeDefinitionForRelease` accepts
  `definitionInput: DefinitionIdentity` and immediately parses it with
  `definitionIdentitySchema`.
- **Impact:** callers may infer that input is trusted even though this function
  intentionally owns runtime parsing. Some application seams pass data derived
  from requests or persisted envelopes.
- **Required change:** accept `unknown`, return the same precise resolved type,
  and retain runtime parsing. This makes the interface truthfully describe the
  module's leverage.
- **Verification:** typecheck all callers and retain valid/malformed identity
  tests.

### Current remediation evidence

| Finding | Repository evidence | Verification |
| --- | --- | --- |
| NC-001 | `release-history.golden.ts` independently pins all 30 release fingerprints | The package golden test passes without snapshot regeneration |
| NC-002 | One private staged/active transition implementation and one cohort record replace parallel algorithms while preserving named history | 30 golden fingerprints, every cohort assertion, 19 package tests, typecheck, ESLint, and coverage pass |
| NC-003 | `server.ts` constructs only executors named by the selected release | Dependency getter spies prove core touches no provider and HTTP touches no unrelated provider |
| NC-004 | Tests are split into release/cohort history, definition resolution, server composition, and package-contract owners | 4 files and 19 tests pass independently; largest file is 917 lines; test clones improve to 6 groups/267 lines/0.28% |
| NC-005 | Package-owned coverage thresholds execute from root `test:coverage` and CI | 96.69% statements/lines, 87.23% branches, 100% functions |
| NC-006 | Definition resolution accepts `unknown` and owns runtime parsing | Package and repository consumer typechecks pass |

## Non-findings and rejected refactors

- The package itself is necessary; moving cohort logic into API and worker would
  duplicate a correctness-critical invariant.
- The browser/server split is justified by two real consumers and should remain.
- `server.ts` is cohesive composition and does not need file splitting solely
  because it is 150 lines.
- Linear lookup over the current small immutable catalog is acceptable; adding a
  process cache now would add state without demonstrated benefit.
- Object freezing is appropriate for published compatibility values and release
  interfaces.
- Explicit named historical releases are useful for fixtures and operator
  reasoning; NC-002 should reduce algorithm duplication without erasing those
  names.
- `.js` import specifiers in `.ts` files are correct NodeNext ESM syntax.

## Recommended repair order

1. Add NC-001 golden release projections before refactoring history code.
2. Characterize every cohort, then deepen repeated construction/mapping under
   NC-002 without changing any fingerprint.
3. Make server adapter construction selective under NC-003.
4. Split test ownership and enforce coverage under NC-004/NC-005.
5. Tighten the small definition-resolution type mismatch in NC-006.

Re-audit the new tree after those changes. Do not update historical golden
fingerprints merely to make a failing test green; any change must be explained
by a new compatibility identity and release.

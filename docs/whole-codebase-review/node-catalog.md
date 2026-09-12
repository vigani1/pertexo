# Node catalog — file-by-file judgment

Primary review: all 17 files read in full. Existing verification: **6 test files,
20 tests passed**. Workspace imports use existing compiled dependency exports;
this is not a fresh full-repository build or provider qualification.

| File | Judgment | Reason / required work |
| --- | --- | --- |
| `packages/node-catalog/src/definition-resolution.ts` | REFACTOR — WQ-006; J05, J09, J11 | Explicit browser allowlist protects executor/ABI/policy privacy. However, projection reparses, fingerprints and clones the same release for each definition through the public single-definition resolver. Keep unknown-input validation at that public resolver, not inside each trusted projection iteration. |
| `packages/node-catalog/src/registry.ts` | KEEP — J01–J05, J14 | The long file is mostly named immutable historical releases and a cohort decision table. Staging, support, serving and historical availability are intentionally distinct. Do not replace reviewed epoch bindings with arithmetic, choose latest implicitly, or rewrite historical exports for brevity. Existing stage/activate helpers already factor the recurring operation. |
| `packages/node-catalog/src/server.ts` | KEEP — J05, J07, J09 | Three explicit provider branches preserve lazy dependency access and independent provider types. A heterogeneous factory table would require casts and obscure ownership for little gain. Exact release identity is checked before adapter construction. Provider defaults here construct clients; tests do not imply live provider access. |
| `packages/node-catalog/src/server-only.ts` | KEEP — J13 | Matches the package's Node-only export condition. |
| `packages/node-catalog/src/index.ts` | KEEP — J09, J13 | Browser-compatible package metadata is broader than the HTTP projection by design; do not confuse browser-safe imports with HTTP authorization/privacy filtering. |
| `packages/node-catalog/test/release-history.golden.ts` | KEEP — J01, J12 | Independently pinned 38 historical digests detect manifest drift. Add successors; never regenerate old expected hashes to make changes pass. |
| `packages/node-catalog/test/release-history.test.ts` | TEST/REFACTOR — WQ-007; J12 | Explicit cohort epochs are an independent oracle and worth retaining. Provider execution and core schema assertions are mixed with history checks; several names promise negative admission assertions absent from their bodies. |
| `packages/node-catalog/test/browser-projection.test.ts` | TEST — WQ-006; J09, J12 | Explicit runtime-field absence and staging exclusion are valuable. Extend across every cohort and nested freeze/byte-equivalent metadata before changing resolution mechanics. |
| `packages/node-catalog/test/definition-resolution.test.ts` | KEEP/run with WQ-006 — J12 | Pins exact manifest and config schema behavior plus missing identity. Add unsupported/malformed release cases if resolver internals change; do not export the trusted helper for tests. |
| `packages/node-catalog/test/server-registry.test.ts` | KEEP — J07, J09, J12 | Dependency getter spies prove irrelevant providers stay untouched; streaming fake exercises dispatch/telemetry and credential zeroing. `as never` fakes occur only in non-execution paths; prefer typed minimal fakes when next editing, but they are not independently a production defect. |
| `packages/node-catalog/test/package-contract.test.ts` | KEEP — J13 | Pins browser/server export separation and forbidden imports. Full transitive browser safety also relies on the repository dependency gate, not the regex alone. |
| `packages/node-catalog/test/coverage-config.test.ts` | KEEP — J12 | Prevents silent exclusion of runtime guard and threshold weakening; this is config evidence, not guard failure-path proof. |
| `packages/node-catalog/package.json` | KEEP — J13 | Explicit default/server conditional exports and three real workspace dependencies. |
| `packages/node-catalog/tsconfig.json` | KEEP — J13 | References correspond to runtime workspace imports; preserves declaration build and browser types. |
| `packages/node-catalog/tsconfig.test.json` | KEEP — J12, J13 | Includes all source/test/config files with no production emission. |
| `packages/node-catalog/vitest.config.ts` | KEEP — J12 | Simple package-local Node runner. |
| `packages/node-catalog/vitest.coverage.config.ts` | KEEP — J12 | Explicit source inventory includes runtime guard; index is export-only. No arbitrary threshold increase substitutes for WQ-007. |

## WQ-006 — validate a release once per catalog projection

**P2 focused REFACTOR; structural redundant work, not a measured latency claim.**
`definition-resolution.ts:130`, especially lines 152–157. API caller:
`apps/api/src/catalog/use-cases.ts:117`.

Current call chain for every included definition:

```ts
resolvePlatformNodeDefinitionForRelease(release, manifest.definition)
// -> parseSupportedPlatformRelease(release)
// -> parseRegistryRelease(release): validate edges, fingerprint, deep clone
// -> search release definitions and registration array
```

The outer function already holds a canonical internally constructed serving
release. Repeating the whole public unknown-input pipeline N times hides work
inside a seemingly simple projection and repeats cloning/hashing. It is not
necessary to add a global cache or loosen the public resolver.

Plan: factor a private resolver for an already validated release and exact
definition, or check registered identity membership once then project the
selected immutable manifests directly. Preserve the existing failure if a
published definition lacks a runtime schema registration. Public
`resolvePlatformNodeDefinitionForRelease(unknown, unknown)` still parses both
arguments and rejects unshipped identities. A local/module-owned immutable
registration index is permissible because registrations are static, but no
cache keyed by arbitrary user objects, epoch alone, or mutable releases.

Acceptance: all 37 cohorts produce identical ordered metadata, epoch/fingerprint,
availability and publication flags; staged definitions remain absent; no runtime
identity fields leak; nested schema objects remain frozen. Unknown public inputs
still fail. Compare before/after outputs and count whole-release validation work
in an isolated test/instrumented probe without adding public counters. Report
latency improvements only if benchmarked. Run catalog and SDK tests plus API
catalog contract tests. Complete WQ-002–WQ-004 first to avoid hiding admission
bugs beneath this refactor.

## WQ-007 — align catalog test names, ownership and negative assertions

**P2 TEST/readability.** `test/release-history.test.ts`, provider tests beginning
around lines 662 and 724, Merge/Parallel tests around lines 792 and 816.

The email and Slack test names claim “no staging admission” but construct only
active registries. The Merge and Parallel names claim “only in its additive
release” but do not try a preceding release. Separate generic HTTP staging
rejection and lifecycle-table checks help, but do not make each named claim true.

Plan:

1. Add explicit staged registry rejection for each provider and predecessor
   missing-definition/executor assertions for the additive node cases, or rename
   tests to the narrower behavior and link a parameterized cohort-level negative
   matrix that actually proves the broader claim. Prefer the matrix if it avoids
   repeating large setup while identifying each cohort in failures.
2. Add email `sendNotification` call-count and secret-zeroing assertions matching
   the Slack composition evidence; fake secrets remain test-only constants.
3. Keep golden history/cohort assertions in release-history; move provider
   composition scenarios alongside server-registry tests and core execution
   smoke cases to a clearly named cohort-execution test file. Do not duplicate
   all core node semantics already covered in nodes-core.
4. Keep the explicit independently authored expected epoch table and coverage
   equality against `PLATFORM_RELEASE_COHORTS`; do not derive expected epochs
   from the implementation table. Parameterized cases may improve failure
   isolation, but must retain full matrix coverage and golden digests.

Acceptance: every test name matches its assertions; each tested staged release
rejects without provider dispatch; active execution still succeeds, secrets are
zeroed, and retained digests remain unchanged. Run all catalog tests/typecheck.
No production source change is required for this item.

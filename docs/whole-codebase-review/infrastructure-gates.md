# Infrastructure: source/build/documentation and small quality gates

Date: 2026-09-12. Primary reviewer fully read these 36 files. Fourteen existing
test files executed: 66 tests passed. Tests with leaking fixture directories
were read, not rerun. No upstream registry fetch or service was invoked.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `infrastructure/browser-entry-dependencies.mjs` | KEEP; scoped TEST | AST runtime/type distinction, explicit browser export selection and visited traversal are readable. Gate covers first-party edges, not transitive npm browser compatibility; unresolved workspace/relative imports should produce diagnostics rather than silently resemble external packages. Add nested-condition/missing-source tests before widening resolver; do not claim current browser leakage. |
| `infrastructure/browser-entry-dependencies.test.mjs` | WQ-212 | Four useful reachable/type-only/dynamic/server cases; fixture owns a temporary directory but never removes it, including setup failure. |
| `infrastructure/validate-built-package-exports.mjs` | WQ-213 | Real self-reference import proves built resolution rather than source aliasing; precise invalid-target code distinguishes browser rejection from missing dist. Synchronous import child has no deadline. |
| `infrastructure/validate-built-package-exports.test.mjs` | KEEP; WQ-213 TEST | Temporary directories are removed in finally; add hanging import and successful resolved-target assertions so browser/node exports cannot accidentally swap unnoticed. |
| `infrastructure/validate-module-imports.mjs` | KEEP | Runtime graph deliberately excludes deferred cycles while still enforcing ownership for deferred/type references. AST branch count reflects distinct syntax, not business complexity; local paths and traversal are sufficiently contained. |
| `infrastructure/validate-module-imports.test.mjs` | KEEP | Syntax matrix covers side-effect, empty, mixed and type-only declarations plus ownership escape. Pure source strings keep each regression legible. |
| `infrastructure/validate-project-references.mjs` | KEEP | Separate compare and graph-cycle phases reconcile runtime workspace dependencies, reject app dependency and unknown workspace. Does not promise devDependency graph analysis; retain scope. |
| `infrastructure/validate-project-references.test.mjs` | KEEP | Independent fresh fixtures cover missing/duplicate/unexpected/unknown/cycle and actual repo graph; no redundant helper framework. |
| `infrastructure/validate-runtime-major.mjs` | KEEP | YAML parsing defeats misleading run-block text and duplicate keys. Literal CI selectors and same-major engine bounds are explicit policy. Docker FROM regex covers current literal syntax, not every possible Dockerfile. |
| `infrastructure/validate-runtime-major.test.mjs` | KEEP | Negative YAML/selector matrix distinguishes absent, sibling, dynamic and quoted action forms; realistic fixture generation is readable. |
| `infrastructure/validate-image-pins.mjs` | KEEP; bounded TEST | Deterministic pin syntax check appropriately avoids tag resolution. Add registry-with-port/no-tag and quoted-whitespace fixtures; colon anywhere is weaker than a tag on the final path segment. This is format assurance, not signature verification. |
| `infrastructure/validate-image-pins.test.mjs` | KEEP | Five independent tag/digest/env cases; extend exact grammar cases with validator, do not add live registry requirements. |
| `infrastructure/create-image-provenance.mjs` | KEEP | Hashes evidence bytes and records immutable build digest plus full commit. It produces an unsigned local evidence manifest, not independently verified SBOM/image association or signed attestation; keep promotion mode explicit. |
| `infrastructure/create-image-provenance.test.mjs` | KEEP; TEST | Checks digest identity and rejected mutable metadata. Add deterministic expected hash/change-one-byte and invalid commit/empty-reference cases when touching validation. Current test title should not imply it inspects SBOM contents. |
| `infrastructure/validate-complexity.mjs` | WQ-215 | Function-local branch counting excludes nested bodies, which is appropriate. Name-only identity can overwrite multiple same-named methods/functions in one file; numerical ratchet is triage, not readability proof. |
| `infrastructure/validate-complexity.test.mjs` | WQ-215 TEST | Exercises comparison only, not AST inventory/key construction. Duplicate-name extractor coverage is needed. |
| `infrastructure/validate-test-duplication.mjs` | WQ-216; shared WQ-213 | Exact fragment hashes and per-review stale detection avoid hiding new clones behind totals. Missing/nonfinite totals are not rejected; jscpd child has no own deadline. Cleanup preserves primary failure correctly. |
| `infrastructure/validate-test-duplication.test.mjs` | WQ-216 TEST | Growth/unexplained/stale cases are meaningful; malformed report shape and counts are untested. |
| `infrastructure/validate-vitest-gate-report.mjs` | KEEP | Explicit finite safe integer counts, required passing cohort and exact pending count make fail-closed behavior readable. Pending count is not identity proof of which provider tests were skipped; verify intended exclusions in cohort config. |
| `infrastructure/validate-vitest-gate-report.test.mjs` | KEEP | Covers zero execution, unexpected pending/todo and explicit pending allowance. No need to collapse scenarios into an opaque table. |
| `infrastructure/merge-istanbul-coverage.mjs` | WQ-216 | Exact instrumentation comparison is justified; counter shape/value validation missing before addition. |
| `infrastructure/merge-istanbul-coverage.test.mjs` | WQ-216 TEST | Sum and map mismatch are covered; missing counters, branch arity, invalid hits and first-report validation are not. |
| `infrastructure/validate-database-schema.mjs` | KEEP; shared WQ-203 | Registry/typed table inventory is useful static ownership evidence. Concatenated migration regex does not calculate final RLS or detect later drops/disable; keep real-role/catalog tests authoritative. |
| `infrastructure/validate-database-schema.test.mjs` | KEEP; TEST | Current 68/49/19 ownership counts guard inventory drift; not a SQL privilege proof. Add injected malformed registry tests only when extracting a pure parser is useful. |
| `infrastructure/validate-documentation.mjs` | WQ-214 | Markdown token parsing excludes code examples, GitHub slugging handles headings, and audit-tree ancestry is isolated from hook Git env. Empty path incorrectly selects directory rather than current file. |
| `infrastructure/validate-documentation.test.mjs` | WQ-212/WQ-214 | Strong ancestry/recreated-tree fixtures but all temporary repositories lack teardown; same-document anchor test absent. Fixture git operations are isolated from main repository. |
| `infrastructure/operational-documentation.mjs` | KEEP | Small deliberately scoped live-section rules avoid changing historical evidence. Text delimiters are a maintenance contract rather than a general Markdown parser; failure messages identify missing authority. |
| `infrastructure/operational-documentation.test.mjs` | KEEP | Mutates actual documents to expose stale live scalar/anchor policies while preserving historical sections; useful executable documentation checks. |
| `infrastructure/documentation-git-isolation.test.mjs` | KEEP | Protected repo sentinel/config/head and nonzero child test count establish isolation under inherited hook metadata. Outer directory removed; nested fixture cleanup belongs WQ-212. |
| `infrastructure/git-environment.mjs` | KEEP | One small named operation removes all Git overrides for explicitly targeted repo commands; no more general environment framework needed. |
| `infrastructure/install-git-hooks.mjs` | KEEP; conditional integration TEST | Explicit install mutation is clear and skips non-worktrees. Test custom existing hooksPath and inherited Git env before deciding preservation/override policy; never run this as an audit check. |
| `infrastructure/temporary-directory-cleanup.mjs` | KEEP | Explicit failed flag preserves even undefined primary rejection, aggregates cleanup failure and normalizes cleanup-only non-Error. Local filesystem boundary does not need arbitrary hostile-proxy hardening. |
| `infrastructure/test-process-observation.mjs` | KEEP | Bounded file polling distinguishes ENOENT from real IO failure; kill-zero distinguishes ESRCH from permission/invalid PID. Test-only wall clock is acceptable at current scale. |
| `infrastructure/test-process-observation.test.mjs` | KEEP | Focused invalid path/PID and current-process observations avoid false absence from swallowed errors. |
| `infrastructure/validate-iana-address-registry.mjs` | KEEP | Offline structural check versus explicit upstream byte drift check is a clean operational boundary; 30s abort bounds trusted registry fetch. Semantic review remains manual; do not autoapprove changed policy bytes. |
| `infrastructure/validate-iana-address-registry.test.mjs` | KEEP | Synthetic response proves fail-closed byte drift without network. Add non-OK status on routine next touch; no current defect implied. |

## WQ-212 — dispose test-owned temporary repositories/directories

P2 FIX. `browser-entry-dependencies.test.mjs:fixture` and
`validate-documentation.test.mjs:createRepository` allocate with mkdtemp and
have no rm or registered teardown. Every run leaves files (including Git repos),
and the isolation suite multiplies this by rerunning documentation tests.
Pass test context to the fixture and register removal immediately after mkdtemp,
before mkdir/write/git setup can reject. Scope recursive cleanup to the exact
returned directory; preserve primary assertion/setup failures if removal fails.
Test setup failure and normal completion against a controlled temp parent, and
assert no owned residue; do not delete unrelated prior tmp directories. Extend
to additional identical ownership omissions only after inspecting each helper.

## WQ-213 — bound local gate subprocess completion

P2 FIX/TEST. `validate-built-package-exports.mjs:validateBuiltPackageExports`
calls spawnSync for each runtime import without timeout. An export that leaves
a referenced timer or hangs at top-level blocks this local gate indefinitely;
CI's outer timeout is not bounded ownership in the script. The jscpd child in
`validate-test-duplication.mjs:runJscpd` has the same missing local bound.
First add a controlled import fixture with a referenced timer and a deadline
assertion. Prefer existing owned-process machinery if grandchildren are involved;
a bounded async child wrapper is necessary if TERM may be ignored. Do not claim
spawnSync timeout alone guarantees hard termination. Return precise spawn,
timeout, signal and exit diagnostics without dumping secret-bearing env.
Retain existing per-case import observations and exact browser rejection check.
Use distinct realistic deadlines for import and clone scan; test spawn error,
nonzero exit and successful cleanup. No shared generic runner unless reuse
actually simplifies these owners and preserves kill/reap guarantees.

## WQ-214 — resolve fragment-only links against the current document

P2 FIX, source helper reproduced. `validate-documentation.mjs:localTarget`
currently runs `path.resolve(path.dirname(sourceFile), decodedPath || '.')`.
For `/repo/docs/page.md` and `#heading`, the result is `/repo/docs`; the next
stage rejects a valid heading as a non-Markdown target. Use sourceFile for an
empty decoded path, keeping repository-rooted and relative paths distinct.
Regression cases: valid/missing local fragment, query-plus-fragment, empty href,
encoded fragment, repeated heading slugs and repo escape. Preserve external
scheme skip and percent-error diagnostics. Run existing link/ancestry/isolation
tests after fixing their cleanup through WQ-212; no historical audit-tree rewrite.

## WQ-215 — make complexity observations uniquely addressable

P2 TEST/FIX. `validate-complexity.mjs:functionName` keys a named method only by
its local name; `inventory` assigns `functionHotspots[measurement.key]` and
overwrites earlier qualifying methods of the same name in the same file.
Anonymous ordinal also shifts after unrelated insertions. Add AST fixture with
two classes containing same-named qualifying methods and different counts;
assert both observations survive and worsening either is detected. Use stable
lexical owner-qualified names (and deliberate duplicate disambiguation), retaining
readable names in diagnostics. Extract inventory as a testable operation rather
than testing only synthetic comparison objects. Regenerate only necessary
baseline keys after reviewing old-to-new mapping; preserve ceilings and reasons.
Do not lower measured complexity by minifying code or splitting guards.

## WQ-216 — validate machine evidence before aggregating it

P2 FIX, two pure current-source probes reproduced. `validateCloneReport` accepts
`statistics.total={}` with `duplicates=[]` and an empty reviewed family list,
because `undefined > maximum` is false. `mergeIstanbulCoverage` accepts matching
maps with a missing second hit key: `1 + undefined` becomes NaN (JSON output
null). Neither result is valid machine evidence. This is not a claim the pinned
tools currently emit corrupt reports or that downstream coverage necessarily
passes them.

Validate required report fields, finite nonnegative integer hits/counts,
map/counter key correspondence and each branch's arity before merge/comparison,
including the first report. Reject missing/extra keys, negatives, fractional or
nonfinite values, malformed totals and inconsistent totals where the tool schema
defines that invariant. Avoid coercing null/string values to counts. Add separate
pure boundary tests in the two existing test files, preserving exact fragment
fingerprints, map identity and valid deterministic sums. Keep unrelated
tool-specific shapes separate; no large cross-tool validation framework.

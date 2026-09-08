# Low-value code audit

Reviewed 2026-09-06, starting from `8ceb7a06`. Scope: redundant tests, trivial
wrappers, dead abstractions, duplicate helpers, stale comments and unnecessary
ceremony. This is a focused removal audit, not a new correctness certification.
Generated output, dependencies, local environment files and historical SQL
migrations were not deletion targets.

## Changes and safety evidence

| Removal | Why safe | Verification |
| --- | --- | --- |
| Overwritten workflow-model selector in `eslint.config.mjs` | The later model-specific rule already replaces it; the engine selector remains. | Resolved full configurations for model/engine source and tests have identical SHA-256 hashes before/after; lint passes. |
| Unmatched `packages/integrations/*` workspace glob | Integrations is one workspace; no nested package manifests exist. | Same 18 workspace names before/after; frozen-lockfile validation passes with no lockfile change. |
| Local `requestSignal` in the ledger adapter | Its body was byte-for-byte identical to the existing `artifact-request-lifecycle.ts` helper. All four callers now use that same implementation. | 209 artifact-store unit tests and coverage floors pass; the existing cancellation/timeout/client-ownership regression in `test/control-ledger.test.ts` remains intact. |
| Unused private `readyNodeDecision` parameter | `indexes` was never read; the only caller passed a local variable, not an expression with side effects. Index creation and readiness filtering remain unchanged. | 285 engine tests and coverage floors pass, including scheduler projection, branch/join and generated state-machine cases; test typecheck passes. |
| Dummy webhook mock implementation | The mock ignored its argument and always resolved `health`; a typed `mockResolvedValue` preserves that result and recorded calls. | All eight webhook service cases and API test typecheck pass, retaining credential, idempotency and replay assertions. |

The storage coverage review inventory was relocated to the changed source
coordinates. Thirty source-backed fingerprints are unchanged; two existing
V8 locations without executable coordinates were rechecked and fingerprinted
against the updated file. No review classification or coverage floor changed.

## Major-directory inspection

This original pass records directory-level coverage, not an exhaustive
file-by-file certification. A broader tracked-file pass was requested afterward
and is tracked separately in the implementation progress journal.

Source, tests/support, manifests and meaningful import/caller relationships
were inspected in every workspace. A retained row means no safe, worthwhile
removal was established, not that the directory was skipped.

| Directory | Areas inspected / disposition |
| --- | --- |
| `apps/api` | Feature controllers/use cases/guards, identity adapters, platform and bootstrap, tests/support; simplified only the webhook mock. |
| `apps/worker` | Configuration, execution, transport, triggers, runtime, platform, bootstrap and test fixtures; retained lifecycle and dispatch seams. |
| `apps/lifecycle-command` | Configuration, command runner, readiness, main and tests; retained separate authority/process ownership. |
| `apps/operator-command` | Configuration, operator dispatch, main and tests; retained operator credentials and no-listener process. |
| `apps/recovery` | Configuration, restore-before-serve, main and tests; retained recovery ordering. |
| `apps/retention` | Configuration, runner, maintenance loops, main and tests; retained maintenance ownership. |
| `packages/artifact-store` | Store/ledger adapters, lifecycle helpers, encryption, policies and tests; removed exact deadline-helper duplication. |
| `packages/contracts` | Public schemas, HTTP/error/pagination contracts, generated-artifact tooling and tests; retained compatibility aliases and distinct path-parameter semantics. |
| `packages/database` | Persistence domains, platform/config, role-specific exports, schema/migrations, scripts and test/support; retained differing locks, transaction/abort behavior and migration history. |
| `packages/integrations` | HTTP, Slack, email, webhook, credential/crypto modules and tests; retained distinct dispatch/idempotency and provider error policies. |
| `packages/node-catalog` | Release cohorts, registry/server composition and tests; retained historical compatibility evidence and browser-safe identity ownership. |
| `packages/node-sdk` | Contracts, schema documents, registry/runtime, identity/compatibility and tests; retained bounded validation and public exports. |
| `packages/nodes-core` | Node-family definitions/executors/validation, registration and tests; retained family and registration ownership. |
| `packages/observability` | Logging, tracing, metrics, configuration and tests; retained distinct privacy/cardinality/lifecycle contracts. |
| `packages/queue` | Contracts, names/defaults, delivery admission, producer/consumer, Redis helpers and tests; retained differing public error mappings and per-field option documentation. |
| `packages/rate-limit` | Policy, distributed limiter, Redis runtime and tests; retained the post-await state-reading helper after testing its removal. |
| `packages/workflow-engine` | Compilation, checkpoints, scheduling, transitions, testing surface and test families; removed unused private scheduler argument. |
| `packages/workflow-model` | Graph, expressions, mappings, canonical JSON, public facades and tests; retained bounded walkers and package entrypoints. |
| `infrastructure/` | Architecture, runtime, schema, docs, coverage, duplication and image validators and tests; retained independent gate assertions. |
| `infrastructure/ecs` | Rendering, runtime closure, connection budget, release/startup and evidence validation; retained deterministic-render and production-parser checks because they test different properties. |
| `infrastructure/exercises` | Runner, six profiles, validation and tests; retained authentication, response-policy and evidence controls. |
| `infrastructure/observability` | Collector/Prometheus/Grafana configuration and validator; retained configuration ownership. |
| `infrastructure/postgres`, `infrastructure/minio` | Role/bootstrap scripts and storage policies; retained credential and privilege separation. |
| `.github`, `.githooks` | CI/CodeQL/release workflows, dependency policy, ownership and push hook; retained independent runner gates and protected-check names. |
| `docs/`, root files | ADRs, audit/operations indexes, progress, contributor/security guidance, Docker/Compose, manifests and compiler/lint configuration; removed only inactive selectors, preserved historical evidence. |

## Rejected removals

- In the initial pass, no test was proven behaviorally redundant and no tests
  were deleted. Similar
  fixtures cover different authorization, lifecycle, provider or compatibility
  cases; textual duplication alone is insufficient evidence.
- Inlining Redis `isClosed()` triggers `no-unnecessary-condition` after the
  earlier check narrows the field across `await`. The helper deliberately
  reads asynchronously mutable state; removing it would require a suppression
  or a larger rewrite. The attempted change was reverted; all 29 rate-limit
  tests pass.
- Webhook `throwManagementError` centralizes three throws of the deliberately
  frozen application-error value and one justified lint suppression. Inlining
  it duplicates that exception to the throw rule.
- Public compatibility exports, process adapters, per-field documentation and
  historical release/migration evidence were not treated as dead code merely
  because they are small or repetitive.

## Verification

Focused tests, changed-file lint and API/artifact-store/engine typechecks pass.
All 110 infrastructure tests, 15 architecture tests, Knip, complexity and
duplication gates pass. The selected risk report remains at 22 pre-existing
unreviewed and 465 reviewed uncovered branches. Full pre-push verification is
run before publishing each completed checkpoint. No service-backed integration
suite is required for these behavior-preserving removals; no local services
were started, stopped or reconfigured for this audit.

## File-by-file follow-up: tooling checkpoint

The broader pass starts at `e4feb99d`. Its first completed cleanup removes:

- The `apps/web` ESLint block: no tracked file matches it, and the authoritative
  plan explicitly defers the web client outside this checkout. The resolved
  configurations for all 1,140 tracked TypeScript/MJS files retain the same
  aggregate SHA-256 (`72ad2c60190bfaa4c175966b6550fdc251ede32449f5ef2869a9adbe57d09183`).
- The unused `task` argument of the rendered-startup negative-config helper.
  AST inspection proves zero parameter reads, an unchanged function body and
  one caller with identical remaining arguments. No runtime startup behavior
  changes; the service-backed smoke exercise is not claimed as rerun.
- The second `signal.threshold <= 0` predicate in deployment validation. The
  preceding unconditional signal validation already rejects it. Fifty-two
  before/after cases preserve exact acceptance and error messages, including
  invalid types, non-finite values and boundary values across all four signals.
- The outer `doesNotReject` callback around the schema-count equality assertion.
  The async test still awaits validation and fails on rejection or mismatched
  counts, preserving the same three schema ownership assertions.

Changed-file lint, schema validation and deployment checks verify this checkpoint.
Full review coverage and remaining dispositions are recorded in the conclusion.

### Private Slack send-helper checkpoint

The private `execute` helper in `packages/integrations/src/slack/client.ts`
has one caller, `sendMessage`, which always supplies an encoded body and its
required `AbortSignal`. Its unused undefined alternatives and conditional
spreads are removed. The public `authTest` path still accepts an optional
signal and has separate response semantics; neither public contract changes.
The two exact unreachable reviews for the removed branches are deleted from
the risk manifest, rather than left stale or reassigned to other sites.

All 223 integration-package tests, its typecheck, changed-file lint and risk
report checks pass. The report has 22 pre-existing unreviewed and 463 reviewed
uncovered sites; coverage floors are unchanged. Source/test duplication gates
remain green at 28/5 groups and 563/235 aggregate lines respectively.

### Live documentation checkpoint

Live guidance now links to executable coverage/duplication owners instead of
stale current counts. README preserves the unresolved API scope and production
evidence requirements; the complexity register and component audit index label
their dated measurements and narratives as historical. ADR 001 gains a dated
clarification of the plan's existing backend-only checkout scope, and the phase
terminology ledger names the current worker checkpoint owner. No historical
finding or measurement is rewritten as if later fixes existed at its pinned tree.

Inventory coverage and full-content review are separate evidence. Automated
byte reads and checksums do not establish semantic review; the tracked-file
reconciliation remains open until the content-review coverage is established.

### Lifecycle coverage configuration checkpoint

The lifecycle coverage configuration now owns its four-file cohort directly.
Its regression test compares the actual configuration to the independently
pinned audited list, preserving protection against silently dropping a file.
The test-only constant export and intermediate assertion are removed; the test
itself and the separate risk-report inventory remain. All 25 lifecycle unit
tests, test typecheck, changed-file lint and formatting pass.

### Operator command contract checkpoint

The operator runner consumes the command type already owned by its configuration
instead of repeating the union. Its sole production caller passes that parsed
command; the type-only import introduces no runtime dependency, and emitted
runner JavaScript is identical. Eight identical strict `OPERATOR_DRY_RUN`
parsers now reuse one file-local schema, without adding defaults or coercion.
Across ten command variants and eleven valid/invalid dry-run values, all 110
before/after results or complete validation issues match exactly. All eight
operator unit tests, test typecheck, changed-file lint and formatting pass.
The full push gate additionally caught the obsolete clone review for the removed
type repetition. That exact entry is removed; the source scan falls from 28
groups / 563 lines to 27 groups / 512 lines, with no raised allowance.

### Worker test-value checkpoint

Two preview-maintenance bootstrap tests had identical 31-line callback bodies,
confirmed by AST extraction and exact text comparison. The duplicate named
`routes preview reconciliation through its maintenance consumer` is removed;
`gates preview reconciliation dispatch on its maintenance consumer` retains all
readiness and cleanup assertions. The obsolete bootstrap clone review is removed
rather than retained under its inaccurate distinct-scenario explanation.

The HTTP and Slack telemetry tests also asserted that their own literal expected
objects lacked sensitive keys. Those two assertions cannot detect production
regressions and are removed. Exact comparisons against emitted metric arguments
remain, as do the HTTP span-attribute and all provider failure/lifecycle checks.
All 277 worker unit tests, test typecheck, changed-file lint and formatting pass.
Test duplication falls from five groups / 235 lines to four groups / 203 lines;
source duplication remains at 27 groups / 512 lines. No coverage floor changes.

### Worker indirection checkpoint

The worker review now covers all 136 tracked files by full content, including
integration tests and their support code. The completion-result wrapper and the
single-call queue-job observation wrapper are inlined without changing their
expressions. A no-op success-kind read and an already-used fixture variable's
no-op read are removed. The compatibility test names its release constant
directly, and the preview trace fixture becomes a constant: its old sequence
argument was ignored at all eight call sites.

The preview delivery test's checksum comparison hashed the same test-local
payload twice, once through a shallow copy. It did not compare transport data
with a persisted checksum, despite its comment. Remove that assertion and its
now-unused field-access helper; retain execution, output, fence, inbox and exact
redelivery assertions. The transaction and recovery fixtures remain because
they expose distinct durable-state and process-crash scenarios.

Verification: all 277 worker unit tests, test typecheck, changed-file lint and
formatting pass. The preview delivery and Validate integration suites pass all
three tests against disposable PostgreSQL databases and a separate temporary
Redis instance; the temporary container is removed afterward. Existing Redis
test data is untouched. The other service-loss and SIGKILL suites were reviewed
but not rerun for these expression-preserving edits. Duplication remains at 27
source groups / 512 lines and four test groups / 203 lines, with unchanged gates.

### Database test-value checkpoint

Thirty historical migration tests repeated the same current migration-head
constant comparison. Those comparisons did not exercise the migrations under
test. One explicit serving-readiness test now pins that reviewed head; the
migration-specific SQL, privilege, immutability and retention assertions remain,
as do every integration test's actual readiness and applied-migration checks.

The connection package test also built typed fake objects and asserted their
own keys. Remove that test and its five type-only imports. The neighboring test
asserts the same exact keys on the real role-specific factories, whose explicit
return types continue to check the composed capability contracts. Runtime export
checks remain. All 238 database unit tests and test typecheck pass. No production
or migration SQL changes are included, so database integration suites are not
rerun for this test-only checkpoint.

### API test-value checkpoint

The OIDC provider-failure test previously asserted only inside `catch`, so a
resolved login could pass without assertions. It now requires rejection on one
captured promise and checks its type, public classification and sanitized message.
The encryption test helper also captures one invocation's failure, instead of
calling the operation twice for separate checks.

Remove an exact repeated authorization-count assertion and two assertions about
sensitive literals never supplied to the code under test. Exact emitted metric
arguments and safe public error details remain. Three graph/module test titles
now describe only the cases they actually assert.

The SSE pseudo-load test generated 1,000 identical 250-ms observations from a
fixed clock, then asserted their p95 was under two seconds. It did not exercise
streams or measure load. Delete it and cover its two path labels in the existing
latency-calculation unit test. Deployed SSE latency/load evidence remains an open
Phase 7 obligation, not a result of this test suite. All 476 API unit tests and
test typecheck pass; this checkpoint changes no production code.

### API indirection checkpoint

The HTTP platform now owns the frozen-application-error throw policy and its
single lint exception. Five identical local helpers disappear; rate-limit and
the two workflow mappers use that same throw operation while retaining their
own error construction/classification. Existing consumer and problem-filter
tests exercise the real error values rather than a new helper-only test.

Remove `WorkflowVersionListingUnavailableError`: its only constructor call was
the mapping test, and version listing already requires/calls persistence. The
general unexpected-error mapping remains. Inline the sole session-cookie reader
wrapper and the sole webhook request-signal forwarding wrapper. Webhook request
IDs reuse the platform parser with the exact same type check and regular
expression. Raw signature-header multiplicity checks, encryption cancellation,
secret zeroing and problem status validation remain separate and unchanged.
The authorization error test now checks type and code on one rejected promise,
removing a second identical call and its conditional assertions. All 476 API
unit tests, test typecheck and changed-file lint pass.

### Domain indirection checkpoint

Remove the expression evaluator's `preview` and `runtime` aliases: both only
forwarded to `evaluate`, their only callers were parity assertions, and the
shared evaluator interface already exposes `evaluate` alone. Keep real worker
value/missing/error, cancellation, resource-limit and timeout tests. Remove the
positive elapsed-time assertion while retaining timing diagnostics and the
separate timeout-ceiling regression.

Checkpoint ledger parsing now uses its existing six-value disposition guard
without rebuilding and checking the same six-value array again. Exact-key and
hostile-input checks remain. Remove the scheduler export assertion already
executed by the immediately preceding loop. All 91 workflow-model and 285 engine
tests, coverage floors and their test typechecks pass. Changed-file lint initially
exceeded the default Node heap; it passes with the repository lint script's
8-GiB heap setting. Formatting passes; no coverage threshold changes.

The full push gate caught one generated empty-location V8 branch review whose
fingerprint includes the whole checkpoint source file. Its owning artifact
output decision at lines 277-285 is unchanged, and its second branch location
still has empty start/end coordinates. Refresh only that fingerprint; preserve
the generated classification and justification. The other source-backed review
fingerprint is identical. The risk report still has 22 unreviewed and 463 reviewed
sites; the failed push did not update the remote.

## File-by-file conclusion

Completed 2026-09-08. The follow-up baseline is `e4feb99d`; the
[per-file ledger](./audits/low-value-code-file-ledger.tsv) contains exactly its
1,430 tracked paths, with no duplicate or missing rows. Its comparison tree is
`ef410ea5` (1,429 paths): the removed SSE pseudo-load test has an empty current
blob and `deleted` status. The subsequent domain checkpoint `e2fb4ccd` changes
four reviewed source/test files and these two journals; `e2ac7a0e` reconciles
one coverage fingerprint. Neither changes path membership. The ledger itself is
a new documentation artifact, not an omitted baseline source file.

| Disposition | Baseline files | What was established |
| --- | ---: | --- |
| Full-body review | 1,330 | Source, tests, configuration, tooling and prose read in full across the review team; candidates checked against callers and ownership. |
| Generated validation | 17 | Sixteen contract artifacts checked against deterministic generation; the lockfile structurally checked and frozen-lockfile validation passed. Not manual source review. |
| Coverage-policy data review | 1 | All risk-review groups structurally inspected; changed locations and obsolete entries checked by the risk gate. Not a fresh semantic reclassification of every historical justification. |
| Historical migration inventory | 82 | Each migration recorded by path, size and identity, with immutable-checksum and schema-gate evidence. No claim of a fresh statement-by-statement migration/security certification. |

The ledger's `primary`, `apps`, `domain` and `adapter` labels identify review
assignments. Thirty-seven primary/adapter overlaps are intentionally deduplicated
into single rows. The later full-content domain pass supersedes its earlier
structural-only inventory; all 255 nongenerated domain files received full-body
review. Blob columns prove tree membership and identity, not review quality.
This is a pinned audit record, not a CI allowlist or a promise about future files.

### Retained and deferred candidates

The module-design review favors fewer methods and shared implementations where
caller behavior is proven equivalent. It does not treat every small file or
repeated-looking check as waste. No additional directory reshuffle was justified
by this pass; process authority, domain ownership, browser/server entrypoints and
versioned node-family organization remain meaningful.

- Keep role-specific persistence factories, transaction/recovery fixtures,
  independently versioned provider/release matrices and public package aliases.
  Similar shape is not equivalent authority, failure behavior or compatibility.
- Keep lexical migration gates alongside integration tests: they provide fast,
  independent regression checks. Do not merge preview claim/cleanup receipt
  helpers whose error classes and lifecycle contracts differ.
- Keep hostile-input validation at public and persisted seams. Consolidating
  graph reparsing, checkpoint scope parsers or repeated executable-tree lookups
  remains a possible focused redesign, not a proved behavior-preserving deletion.
- Keep tiny local test utilities when sharing them would introduce cross-package
  coupling, and keep mutation/export-layout checks that enforce a documented
  contract. Some single-caller mapping helpers still provide useful naming.
- Do not replace trigger projection canonicalization with the general canonical
  JSON helper: their sorting differs and the projection fingerprint is persisted.
  Any unification needs an explicit compatibility decision and regression proof.
- A missing trigger event is currently rejected while parsing its payload before
  the explicit missing-row branch. Improving that diagnostic remains deferred;
  changing its order would change observable error behavior, not just remove code.
- Validate issue-metadata consolidation and broader retained-catalog test
  deduplication remain possible follow-ups. This pass does not claim they were
  implemented or that every remaining line is indispensable. The engine test
  named for repeated-definition deduplication currently proves build success and
  checksum shape, not the selected-definition set; stronger behavioral evidence
  for that assertion also remains a follow-up.

### Final verification and limits

Implementation checkpoints created by this follow-up, in order:

| Commit | Purpose |
| --- | --- |
| `afa5a7ac` | Remove verified tooling leftovers. |
| `b36570a1` | Remove unused private Slack send alternatives. |
| `c2e9f5d1` | Distinguish live guidance from historical audit evidence. |
| `8ebc2b0e` | Simplify lifecycle coverage configuration. |
| `a5e4f2bd` | Reuse operator command contracts. |
| `5aa6739f` | Remove the obsolete operator clone review. |
| `bb2e1351` | Remove redundant worker assertions and an exact duplicate test. |
| `3701a62a` | Remove shallow worker indirection. |
| `7b970d4d` | Consolidate database contract assertions. |
| `b32267a4` | Remove vacuous API assertions and the pseudo-load test. |
| `ef410ea5` | Remove shallow API indirection. |
| `e2fb4ccd` | Remove redundant domain indirection. |
| `e2ac7a0e` | Reconcile the checkpoint coverage fingerprint. |

The domain checkpoint passes the full repository pre-push gate: formatting,
documentation, runtime/architecture/dependency/schema checks, build, lint,
complexity, duplication, generated contracts, all unit suites, typechecks and
all configured coverage gates. Earlier checkpoint sections record their narrow
proofs and the three disposable-service preview integration tests.

The entire integration matrix, service-loss/SIGKILL exercises, deployed load/SLO
tests and external-platform readiness were not rerun for this cleanup. The
selected risk report still has 22 pre-existing unreviewed uncovered branches;
463 reviewed sites remain, and no coverage floor or detector threshold was
lowered. Passing these checks does not certify an absence of defects or close
the backend plan's remaining delivery requirements.

## Deferred-improvement implementation

The user requested implementation of the deferred candidates on 2026-09-08.
The checkpoints below supersede their earlier deferred dispositions as they
complete; intentionally retained safeguards remain in place.

### Repeated-definition selection evidence

The engine identity test now compares compatibility selection fingerprints for
a graph and the same graph extended by another node of an already-selected
definition. It requires identical selections but different executable checksums,
making the subset-versus-graph distinction explicit. The old test already
implicitly required successful deduplication because the SDK rejects duplicate
selected identities; its checksum-format assertion did not explain that proof.
All 24 identity tests pass, along with the engine test typecheck and scoped lint.

### Missing trigger-event diagnostic

Check whether the tenant-scoped outbox query returned an event before parsing
its payload. A missing event now uses the already-defined unavailable-event
diagnostic; a present malformed payload keeps the invalid-payload diagnostic.
Both retain `WorkflowTriggerReconciliationMismatchError`, fail before receipt
admission and leave durable verification and authorization unchanged.

The new missing-event case first fails against the old implementation with the
wrong message. After the fix, it and the malformed-payload case pass, including
exact absence of inbox receipts. All 12 webhook integration tests pass against
the existing fixture's disposable PostgreSQL database; its teardown removes the
database without touching application data. All 238 database unit tests, test
typecheck and scoped lint also pass. No migration or SQL-policy changes.

### Validate issue metadata

One browser-safe internal table now owns semantic keys, wire codes and fixed
messages. Public exports, ordered enum values and schema behavior remain intact;
the schema and evaluator derive their lookup maps from the same owner. All 96
core tests pass, including independently pinned values, frozen exports and
acceptance/rejection checks for all nine code/message pairs. Build, test
typecheck and scoped lint pass; the retained catalog fingerprint goldens pass
unchanged.

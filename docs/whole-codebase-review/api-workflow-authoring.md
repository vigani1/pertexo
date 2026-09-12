# API workflow authoring review

Date: 2026-09-12. Scope: 29 frozen inventory files read in full by the primary
reviewer. All 8 unit files / 60 tests passed. The two service integration files
and their fixture were read, not executed. ADR-011 was read in full; related
database draft-store code was checked without counting that database module
as complete in this ledger.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/src/workflow-authoring/controllers.ts` | REFACTOR/TEST WQ-083 | Routes visibly specify authorization, CSRF, rate-limit and status. ETag remains transport output, not a locally recomputed conflict. Repeated actor/authorization/identifier wrappers obscure an existing shared projection; nine constructor dependencies suggest splitting coherent read/edit/lifecycle controllers only if tests and navigation improve. |
| `apps/api/src/workflow-authoring/cursor.ts` | KEEP; TEST/CONDITIONAL WQ-083 | Tagged workflow/version payloads and strict decoded schemas are clear. Decoding is lenient base64url and direct calls have no length bound; HTTP query schema supplies the ordinary bound. This is not an authorization token, so noncanonical equivalent encodings are not a demonstrated security defect. |
| `apps/api/src/workflow-authoring/errors.ts` | KEEP; REFACTOR/TEST WQ-083 | Distinguishes draft versus lifecycle concurrency and preserves safe details. Import InvalidWorkflowCursorError from its defining cursor module rather than loading the use-case re-export for a single error class. Keep unknown containment under WQ-055. |
| `apps/api/src/workflow-authoring/etag.ts` | KEEP codec; REFACTOR WQ-083 | Thin alias delegates to one canonical tag codec. DraftRepresentation redundantly requires schemaVersion even though the helper derives it from graph; clarify rather than changing retained tag bytes. |
| `apps/api/src/workflow-authoring/graph.ts` | KEEP | Re-export of canonical graph parsing/validation prevents feature-local semantic drift. Its small size is appropriate. |
| `apps/api/src/workflow-authoring/guards.ts` | KEEP | Shared active/not-found policy and four capability-specific subclasses are purposeful. Do not replace visible capability declarations with string-based guard factories. |
| `apps/api/src/workflow-authoring/index.ts` | KEEP | Feature exports are explicit and maintain composition compatibility. Avoid adding private serializer/cursor helpers merely for test convenience. |
| `apps/api/src/workflow-authoring/lifecycle-use-case.ts` | KEEP; TEST WQ-083 | Archive/restore use publication authority and independent lifecycle revision. Request metadata derives from established actor context. Does not pre-read the draft or cancel existing runs; these are important intentional omissions. |
| `apps/api/src/workflow-authoring/module.ts` | KEEP; minor REFACTOR WQ-083 | Explicit providers share persistence, auth and telemetry. Hoist the telemetry default once; retain explicit class/provider ownership rather than a heterogeneous constructor registry. |
| `apps/api/src/workflow-authoring/ports.ts` | KEEP; WQ-082 | Picks the actual persistence methods and leaves lifecycle ownership to runtime. Redundant authorization union constituent can be removed locally. Any save interface change must preserve database revision CAS and align with ADR-011. |
| `apps/api/src/workflow-authoring/preconditions.ts` | KEEP behavior; TEST WQ-083 | Exactly one strong tag and printable idempotency key are distinct contracts. Missing If-Match is 428; missing authoring idempotency currently maps 400 intentionally. Singleton non-string values are treated as absent for If-Match; tests should specify classification rather than just any throw. |
| `apps/api/src/workflow-authoring/restore-version-use-case.ts` | KEEP | Correctly forwards original full tag to a single authoritative restore transaction; strict empty body does not mean publication or lifecycle restore. No idempotency key is added to this CAS edit. |
| `apps/api/src/workflow-authoring/serializers.ts` | KEEP; TEST WQ-083; conditional WQ-082 | Explicit allowlists keep createdBy/workspace persistence details out of public version/summary projections; schemas validate output. Full draft serialization is reused merely to calculate the current tag on save, creating avoidable work but no measured latency finding. |
| `apps/api/src/workflow-authoring/telemetry.ts` | FIX WQ-064 extension | Metric construction/clock/attributes/end are contained, but callback-then-throw trace fallback reruns work. Current-code probe returned created after two work invocations. |
| `apps/api/src/workflow-authoring/tokens.ts` | KEEP | One stable authorization token used consistently by registration and guards. |
| `apps/api/src/workflow-authoring/types.ts` | KEEP | Reuses public schemas and restricts HTTP request/response capabilities. No duplicate workflow domain model. |
| `apps/api/src/workflow-authoring/use-cases.ts` | KEEP core flow; CONDITIONAL WQ-082; TEST WQ-083 | Separate operations preserve authorization and response semantics. Publication explicitly delegates replay-before-current-draft to persistence: keep this correct ordering. Save follows ADR-011's early tag check plus database revision CAS; do not mislabel that documented split as an accidental bug. |
| `apps/api/test/workflow-authoring/controllers.test.ts` | TEST/REFACTOR WQ-083 | Context precedence and ETag propagation are valuable. Several names claim exact delegation, body validation or HTTP 428 while asserting only a header/exception. Synthetic guard context for create uses update capability and proves projection only, not authorization. |
| `apps/api/test/workflow-authoring/errors.test.ts` | KEEP; TEST WQ-083 | Distinct lifecycle conflict details and blocked placement issues are useful. Expand named mapper rows and serialized safe output, not another copy of global filter code. |
| `apps/api/test/workflow-authoring/etag.test.ts` | KEEP; TEST WQ-082/WQ-083 | Deterministic key-order and compatibility change assertions prove codec behavior. The mixed-replica title compares two hashes only; it does not exercise a request racing release activation. |
| `apps/api/test/workflow-authoring/graph.test.ts` | KEEP; TEST WQ-083 | Small feature import smoke test for canonical graph behavior. One graph with both cycle/dangling edge is legitimate aggregation evidence if named that way; detailed independent graph semantics belong to workflow-model tests. |
| `apps/api/test/workflow-authoring/lifecycle.integration.test.ts` | KEEP strong behavior; TEST WQ-084 | Genuine auth/CSRF/role/workspace denial, concurrent replay/CAS and exact audit/outbox deltas. Retained history comparison is meaningful and separate draft/lifecycle identities are protected. Large negative matrix and local duplicated response type can be clearer. |
| `apps/api/test/workflow-authoring/module.test.ts` | KEEP; TEST WQ-083 | Checks registration only for creation/controller/auth. Do not call this whole-module runtime resolution; guard resolution is separately proved elsewhere. |
| `apps/api/test/workflow-authoring/preconditions.test.ts` | TEST WQ-083 | Current boundary cases protect accepted lengths and weak/list/wildcard rejection. Use named cases and exact code classification; one generic throw cannot distinguish missing from malformed. |
| `apps/api/test/workflow-authoring/telemetry.test.ts` | TEST WQ-064/WQ-083 | Normal success/failure label count is checked, but duration and span end counts are not, and no diagnostic failure or duplicate callback is exercised. |
| `apps/api/test/workflow-authoring/use-cases.test.ts` | TEST/REFACTOR WQ-083; WQ-082 | Good no-extra-read publish replay, lifecycle response projection and single conflict snapshot. Broad combined stories, inaccurate capability/cursor claims and missing exact hashes weaken precision. Split by behavior using shared typed fixtures, not by arbitrary line count. |
| `apps/api/test/workflow-authoring/version-restore.integration.test.ts` | KEEP; TEST WQ-084 | Tests real source scope, strict request, auth/CSRF, stale retry and identical-content revision advance while protecting nonempty history. Setup failure can leave an unassigned fixture passed to teardown; add missing active-workflow and source variants with isolated fixtures. |
| `apps/api/test/support/workflow-lifecycle.integration.support.ts` | FIX WQ-084 | Three database owners are acquired and identities resolved before the cleanup try; normal close races app shutdown with the same dependencies and discards failures. Scoped transaction helpers quote role/set workspace/release correctly. Raw seeded legacy version is intentional historical fixture, not proof of current publish readiness. |
| `apps/api/test/support/real-oidc-http.fixture.ts` | KEEP limited fake; TEST WQ-084 | Exercises actual start/callback/cookie transport, but fake exchange ignores verifier/redirect and uses one latest authorization request. Treat as a sequential transport fixture, not cryptographic/provider qualification. Cookie parsing correctly handles expected session names but lacks direct edge tests. |

## WQ-082 — clarify full-tag versus revision-only save authority

**P3 CONDITIONAL/TEST; J01/J05/J10/J14.**
`SaveWorkflowDraftUseCase.execute:186–210` reads/serializes the current draft,
compares the full representation tag, then forwards only `expectedRevision`
to persistence. The database draft store selects a compatibility catalog in
its own transaction and checks revision, not the original full tag.

This **implements ADR-011's numbered save algorithm**: early tag comparison
followed by revision CAS. It is not a demonstrated lost-update defect. ADR-011
also says a compatibility-only rollout changes the selected representation and
requires refetch; a release may change between those two transactions while
revision stays equal. That edge needs an explicit acceptance decision, not a
silent architectural change during cleanliness work. The restore-version
operation already compares its original full tag inside the authority transaction.

Gate: reproduce a controlled release transition between the API draft read and
save transaction, with unchanged revision/graph. Decide whether success under
the initially matched representation is intended or whether full-tag identity
must still match at the write's selected catalog. If current two-stage behavior
is accepted, keep it and document/test that linearization point; make no API
change. If strict write-time tag matching is required, amend ADR-011 **before**
implementation and forward the opaque tag into the transaction that selects
the catalog and performs revision CAS. Keep revision authoritative for
concurrent graph writes; never extract revision from the tag or drop CAS.

Test either decision using deterministic barriers, not sleeps. Include unchanged
catalog save, release-only change, actual revision race, invisible workflow and
single-snapshot conflict metadata. A hash inequality unit test is not this race
proof. Preserve whole-graph semantics, audit atomicity, exact ETag bytes and
existing 412/404 distinction; no merge/CRDT or idempotent PUT feature.

Separately, calculating `currentTag` via complete `serializeWorkflowDraft`
builds/parses a response body that is discarded. If touching this flow, use the
existing tag codec directly from the admitted draft snapshot, retaining required
validation. Do not introduce caching without an invalidation contract or claim
latency gains without measurement. This modest simplification does not require
the conditional authority change.

## WQ-083 — improve authoring locality and test specificity

**P2 REFACTOR/TEST; J02/J04/J05/J06/J12.** Concrete scope:

- `controllers.ts`: use the existing authenticated-context projection once
  per route. Remove wrappers that separately project actor, authorization and
  identifiers; preserve guard precedence and error vocabulary. Route parsing,
  If-Match/idempotency parsing, ETag write and traceparent adaptation remain
  visible transport responsibilities. If splitting the controller, use coherent
  read/draft-edit/lifecycle responsibilities and unchanged route/guard metadata;
  do not add another generic controller superclass.
- `errors.ts`: import `InvalidWorkflowCursorError` from `cursor.ts` directly.
  `module.ts`: compute the effective telemetry once. `ports.ts`: remove the
  redundant object-port union member. These local edits should not expand public
  interfaces or introduce a constructor-registration abstraction.
- `etag.ts`: remove the unused wrapper-level schemaVersion requirement or
  explicitly check it agrees with the graph if a required external caller needs
  that assertion. The canonical graph contains its schema version; never alter
  existing tag bytes just to use an otherwise redundant argument. Add matching
  caller/type tests and graph/workflow-ID/tag sensitivity cases.
- `cursor.ts` tests through list interfaces: malformed decoded JSON, wrong
  variant in **both** directions, unknown fields, absent/invalid date/ID/version,
  empty and bounded HTTP input, exact generated cursor and no-cursor result.
  The current version-cursor test merely round-trips it despite saying variants
  remain distinct. Decide deliberately whether direct decoder requires canonical
  base64url; lenient equivalent encodings currently work. Keep HTTP length bound
  and no tenant-authority claim for a cursor. Do not create a generic cursor
  service for two small variants.
- `controllers.test.ts`: replace `{workflow:{}}`, `{version:{}}` and broad
  `as never` success fakes with valid typed responses. Where a name says
  "delegates once", assert exact count/arguments; the draft/save tests currently
  assert only body/header. Where a name says "does not call", retain the fake
  and assert it; the route/body case currently supplies only a bad route.
  Separate malformed body from malformed route at the correct owner. Direct
  controller exceptions are not proof of real HTTP 400/428; retain those claims
  only in composed HTTP tests.
- `use-cases.test.ts`: split lifecycle/restore, read/cursor, save/CAS and publish
  stories with a shared complete fixture. The named-read-capability test uses an
  owner and counts calls whose payload has no capability; use a viewer/role
  matrix to distinguish read from update/publish. The create test uses a fake
  atomic result and should claim response/command projection, not transaction
  atomicity. Keep real transactional evidence in database integration.
- Add exact canonical publish hash tests for actor/workspace/workflow/original
  tag and exclusion of diagnostic fields; 64-hex regex is only shape evidence.
  Retain publish's no preliminary getDraft assertion, exact completed replay
  after later changes, and no API reread after database conflict. Verify invalid
  compatibility makes validate false even with a structurally valid graph.
- Add output tests for explicit workflow/version allowlists, lifecycle fields,
  exact timestamps, compatibility and retained graph, invalid persistence result
  handling and empty lists. Prefer testing serializers through use cases unless
  a truly independent public serializer interface is intended.
- `preconditions.test.ts`: named tables with exact WorkflowHeaderError codes
  for missing/malformed/empty/multiple/non-string, including valid length edges.
  Preserve current missing-idempotency 400 behavior unless a separate public
  contract change is requested; do not accidentally make all missing headers 428.
- `errors.test.ts`: complete known class rows, unchanged application error,
  unknown fallback and exact safe details. Avoid replacing the global filter's
  redaction tests with assertions on the input exception.
- `module.test.ts`: retain honest registration check; use actual resolution only
  if extending the claim to all use cases/evaluator/guards. Graph smoke tests
  should not duplicate the entire workflow-model validation matrix.

Acceptance: exact claims match exercised seams, each independently invalid
input fails for that reason, current ETag/hash and guard metadata stay unchanged,
and the 8-file unit selection plus API typecheck pass. Locality improvements
must reduce navigation or duplication; file count/line count alone is not success.

## WQ-084 — repair lifecycle fixture ownership without weakening its proofs

**P2 FIX/TEST; J07/J12/J14.**
`workflow-lifecycle.integration.support.ts:136–184` creates identity,
transaction and workspace owners and resolves three users before entering
the cleanup try. Any failure there leaks previously acquired owners. Normal
close at approximately `:246` starts application.close and database.close in
parallel, even though the application uses and also closes those injected
dependencies; allSettled results are ignored. Both integration files declare
an unassigned fixture and unconditionally close it after failed setup.

Acquire owners inside an awaited fixture with cleanup from the first
acquisition. Define exactly when ownership transfers to the application and
close application before any remaining fixture-owned pools/dependencies. Do not
race duplicate closers or close shared aliases twice. Use deferred thunks to
attempt all independent releases; retain setup failure while reporting cleanup
failure. Make close idempotent and tolerate absent fixture in afterAll.
Preserve workspace-scoped transaction helpers and role quoting. Do not add
broad SQL cleanup to an existing shared-service fixture.

The gate currently checks API_IDENTITY_INTEGRATION and API URL only, while
migration/Redis defaults can participate in setup. Use the existing explicit
integration preflight for actually required dependencies and requested-but-
missing configuration. Do not silently run against fallback services merely
because an environment flag was set. Raw seed rows intentionally represent
retained history; label them as such and retain nonempty version/run assertions,
not a claim that the API published a currently executable workflow.

`lifecycle.integration.test.ts`: preserve concurrent exact replay (one original,
one replay), different-key CAS (one 202, one 409), unchanged draft/version/run
history and exact audit/reconciliation counts. Break the large negative matrix
into named independent cases using fresh scenario fixtures, keeping status
restoration in finally. Use the shared LifecycleResponse contract type instead
of copying the public enum/object; keep exact key allowlist assertions as
independent disclosure evidence. A helper named expectExactLifecycleResponse
currently checks ID and strings only—rename it or assert the actual full shape.

`version-restore.integration.test.ts`: keep identical-content revision advance,
stale retry, fresh ETag, source-workflow scope and retained history. Add archived
workflow, unknown/cross-tenant source and builder-positive cases where not
already exercised by an equivalent current database/HTTP story. This is a test
gap, not an assertion that those paths are broken. Test each file by itself
after fixture changes, with setup-failure injection before/after each owner.

`real-oidc-http.fixture.ts`: the one latestRequest slot requires serial login.
Either keep and document the fixture's sequential contract or use per-login
state/code mapping before parallelizing scenarios. It intentionally ignores
PKCE/redirect validation and is not a real provider-conformance test. Add direct
cookie helper cases for scalar/array header forms, missing values and expected
encoded values; do not disclose session material in failure messages. Keep real
start/callback/browser-binding transport and application identity mapping.

Acceptance: failed setup releases prior owners, teardown reports failures
without skipping later resources, no duplicate ownership races, tests run by
file/name independently and all existing authority/history assertions remain.
Execute service-backed checks only in the configured disposable integration
lane. This audit did not run those suites or alter provider/database state.

## Shared telemetry finding and order

Extend WQ-064 to `workflow-authoring/telemetry.ts:106–142` and its tests.
A current-code probe called the tracer callback then threw synchronously;
measure returned `created` with work count **2**. Keep existing metric factory,
safe clock, attributes and end isolation, but make one measured-work promise
authoritative on every trace fallback/rejection. Add before/after-callback
sync/async failure, repeated callback, exact original rejection, duration and
span-end assertions. Do not duplicate business execution to recover tracing.

Implement the WQ-064 extension first, then WQ-084 ownership and WQ-083 focused
test/locality changes. WQ-082 remains conditional until its race/authority gate
is resolved and any required ADR amendment precedes implementation.

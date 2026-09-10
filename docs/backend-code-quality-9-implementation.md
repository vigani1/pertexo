# Backend code quality Q9 implementation record

Updated: 2026-09-10. Status: complete; the final source-stable local
qualification and report-only documentation checks pass.

This is the execution record for
[`backend-code-quality-9-plan.md`](./backend-code-quality-9-plan.md). The plan is
the frozen rubric and scope protocol; this file records candidate identities,
repository-wide scans, decisions, tests and final evidence. The backend plan
and accepted ADRs remain authoritative for behavior.

## Q9-00 frozen candidate

| Field | Frozen value |
| --- | --- |
| Branch/upstream | `main` / `origin/main`; ahead 4, behind 0 |
| HEAD | `0710322c3b541000d4c260c1143081278b95315b` |
| Tracked changes | none |
| Non-ignored untracked changes | `docs/backend-code-quality-9-plan.md` |
| Dirty candidate fingerprint | `bd5e6144105cc59ac38d58e55508baccd72ecc802248a091793dc41912fc998b` |
| Recoverable tracked patch | `coverage/q9-baseline-2026-09-10/baseline-source/tracked.patch`, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Recoverable untracked archive | `coverage/q9-baseline-2026-09-10/baseline-source/untracked.tar.gz`, SHA-256 `1c0ddf492cd0bfe5e3a748f8808e8b8c79613d3c92e4953e1d0670e0223af5a2` |

The ignored archive contains only the non-ignored untracked plan; generated
runtime data, dependency trees, local environment files and secrets were not
captured. The latest pre-Q9 full qualification remains
`coverage/local-quality/2026-09-10t10-48-49-281z-78496-16f7e49b`. Its source
matched the committed code at this starting point; the only intervening
candidate content was this report-only plan, so documentation checks are the
appropriate baseline supplement. Code changes below require a new final full
qualification.

## Repository-wide family scan

The scan used tracked and non-ignored untracked files, package manifests,
TypeScript project references, root/CI scripts, imports/exports/callers and
owning test discovery. Generated `dist/`, dependency trees, ignored coverage
artifacts and Git internals were excluded because they are derived or
non-source. Historical ADRs and completed records were reference-checked but
not rewritten as current implementation.

Query families:

- **N**: current/latest/status/owner terminology, Q/N links, transport
  `Request` versus application `Input`/`Command`, and callers/import aliases.
- **IO**: database clients, `query`, transaction/read callbacks, per-item reads,
  decode/reconcile/project work and resource acquisition.
- **INV**: `assert`/`validate`/`refine`/`parse`, identity/index/scope/join/loop,
  compatibility/release/registration and consumer call chains.
- **OWN**: types or capability contracts imported from concrete handlers,
  package exports, sibling implementations and construction/close ownership.
- **DUP**: equivalent verifier, actor/context, traversal, derived report and
  normalization algorithms, checked with semantic differences and callers.
- **SAFE**: JSON/value boundaries, pools/clients/workers/streams/timers/locks,
  abort/fence/cleanup/primary-plus-cleanup failures and composed tests.
- **EVID**: coverage/integration/mutation/performance producers, readers, gates,
  standalone/CI/full-run entrypoints and source/run identity.
- **BOUND**: pagination, fan-out, collection expansion, scans, serialization,
  buffering, SQL count, supported limits and benchmark populations.

Every matrix cell is one area/family scan record at frozen identity `bd5e6144…`.
An em dash means the queries and semantic/reference trace found no matching
implementation in that area, not that the area was skipped.

| Scanned source area | N | IO | INV | OWN | DUP | SAFE | EVID | BOUND |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `apps/api/src` (`identity*`, `workspaces`, workflow, connection, node-test, artifact, schedules, webhooks, platform) | Q9-N1 | — | Q9-I6 | Q9-O2 | Q9-D2 | Q9-S4 | — | Q9-B6 |
| `apps/worker/src` (`execution`, `transport`, `triggers`, `runtime`, config/composition) | Q9-N2 | — | Q9-I3 | Q9-O1 | Q9-D1 | Q9-S3 | — | Q9-B5 |
| `apps/lifecycle-command/src` | reviewed; stable owner names | — | — | Q9-O5 | — | Q9-S8 | — | Q9-B8 |
| `apps/operator-command/src` | reviewed; stable owner names | — | — | Q9-O5 | — | Q9-S8 | — | Q9-B8 |
| `apps/recovery/src` | reviewed; stable owner names | — | Q9-I6 | Q9-O5 | — | Q9-S8 | — | Q9-B8 |
| `apps/retention/src` | reviewed; stable owner names | — | — | Q9-O5 | — | Q9-S8 | — | Q9-B8 |
| `packages/artifact-store/src` | reviewed; stable contract names | — | — | Q9-O5 | — | Q9-S7 | — | Q9-B7 |
| `packages/contracts/src`, artifacts and scripts | transport names retained | — | Q9-I6 | Q9-O4 | — | Q9-S4 | — | Q9-B6 |
| `packages/database/src`, migrations and readiness | Q9-N3 | Q9-IO1; Q9-IO2 retained | Q9-I1 | Q9-O4 | — | Q9-S1; Q9-S2 | — | Q9-B1; Q9-B2; Q9-B4 |
| `packages/integrations/src` | reviewed; provider names stable | — | Q9-I6 | Q9-O4 | — | Q9-S6 | — | Q9-B7 |
| `packages/node-catalog/src` | reviewed; release names stable | — | Q9-I5 | Q9-O4 | Q9-D5 retained | Q9-S2 | — | Q9-B6 |
| `packages/node-sdk/src` (`definitions`, registry, release, runtime JSON) | reviewed; version names stable | — | Q9-I5 | Q9-O4 | Q9-D5 retained | Q9-S5 | — | Q9-B3; Q9-B6 |
| `packages/nodes-core/src` | reviewed; node family names stable | — | Q9-I5 | Q9-O4 | Q9-D5 retained | Q9-S5 | — | Q9-B3; Q9-B6 |
| `packages/observability/src` | reviewed; metric names stable | — | — | Q9-O5 | — | Q9-S8 | — | Q9-B8 |
| `packages/queue/src` | reviewed; transport names stable | — | — | Q9-O5 | — | Q9-S6 | — | Q9-B7 |
| `packages/rate-limit/src` | reviewed; policy names stable | — | — | Q9-O5 | — | Q9-S6 | — | Q9-B7 |
| `packages/workflow-engine/src` | Q9-N3 | — | Q9-I2 | Q9-O4 | Q9-D5 retained | Q9-S2 | — | Q9-B2; Q9-B4 |
| `packages/workflow-model/src` (`graph`, expressions, canonical JSON, mappings) | Q9-N3 | — | Q9-I4 | Q9-O4 | Q9-D3 | Q9-S5 | — | Q9-B3; Q9-B4 |
| `infrastructure/*.mjs` and root quality scripts | Q9-N4 | — | Q9-I6 | Q9-O3 | Q9-D4 | Q9-S9 | Q9-E1; Q9-E2 | Q9-B8 |
| `infrastructure/performance` | reviewed; schema-v4 names retained | — | Q9-I6 | Q9-O3 | Q9-D4 | Q9-S9 | Q9-E2 | Q9-B5; Q9-B8 |
| `infrastructure/postgres` and migrations tooling | reviewed; role names retained | Q9-IO3 retained | Q9-I6 | Q9-O5 | — | Q9-S8 | Q9-E3 | Q9-B8 |
| `infrastructure/minio` | reviewed; local/AWS distinction retained | — | — | Q9-O5 | — | Q9-S8 | Q9-E3 | Q9-B8 |
| `infrastructure/ecs` | reviewed; deployment names retained | — | Q9-I6 | Q9-O5 | — | Q9-S8 | Q9-E3 | Q9-B8 |
| `infrastructure/observability` | reviewed; evidence names retained | — | — | Q9-O5 | — | Q9-S8 | Q9-E3 | Q9-B8 |
| `infrastructure/exercises` and profiles | reviewed; external evidence names retained | — | Q9-I6 | Q9-O5 | — | Q9-S8 | Q9-E3 | Q9-B8 |
| Root manifests/config, `.github/workflows`, Compose and build references | Q9-N4 | — | Q9-I6 | Q9-O4 | — | Q9-S9 | Q9-E3 | Q9-B8 |
| `docs/` current maps/status/operations, plans, ADRs and historical records | Q9-N4 | — | ADR responsibilities traced | source-of-truth ownership checked | histories intentionally separate | limits/failure contracts checked | Q9-E3 | performance claims checked |

## Occurrence dispositions

### Naming, I/O, invariants, ownership and duplication

| ID | Owner and consumers | Disposition | Evidence / reason |
| --- | --- | --- | --- |
| Q9-N1 | API authenticated command inputs across workflow authoring/runs, connections, node testing, artifacts and identity/workspace | improved | Common successful identity projection now has an explicit owner; `Request`, use-case input and transport-specific names remain distinct. |
| Q9-N2 | Worker production/preview capability context | improved | Neutral `NodeExecutionCapabilityContext` and `NodeExecutionCapabilityFactories`; the old application-private names have no remaining consumers and were removed. |
| Q9-N3 | Input loader, checkpoint rule families, durable release projection and graph walk | improved | Names distinguish permitted scope proof, reconciliation, coordinator projection, loop selection, checkpoint relation families and persisted projection verification. |
| Q9-N4 | Current status and quality-plan navigation | improved | Codebase map routes the completed Q9 checkpoint, links this evidence record and gives owner/test navigation. |
| Q9-IO1 | `loadNodeAttemptInputs` and node-attempt/For Each consumers | improved | One repeatable-read client still owns SQL; pure named families expose scope proof, upstream reconciliation, join projection, loop selection and collection proof without a new public database seam. |
| Q9-IO2 | `workspace-purge.ts#processNext` | intentionally retained | Restartable discovery/claim/external-I/O/fence/checkpoint order and real-service tests are stronger when visible together; Q9 introduced no new evidence to reopen Q08. |
| Q9-IO3 | Migration/readiness and representative PostgreSQL plan capture | already compliant | Set-based migrations, explicit roles and runner-owned databases; no matching per-item application I/O introduced. |
| Q9-I1 | Persisted V1/V2 checkpoint codec and initial checkpoint parser | improved | V2 branch selection, invocation scope, join scope, and loop/budget/wait families have named private owners invoked in original order; wire schema and generic public error are unchanged. |
| Q9-I2 | `assertCheckpointMatchesExecutable` through `advanceWorkflow` | intentionally retained | One topology-aware authority remains intact; one-field identity drift tables cover unknown/noncanonical/admitted/join/loop cases and For Each suites cover topology/scope. Splitting would obscure precedence without removing duplication. |
| Q9-I3 | Worker persisted projection versus executable envelope | improved | Both public engines call one exact-release verifier; no latest fallback or API publication semantics moved into it. |
| Q9-I4 | Workflow-model validation and identity-derived reports | already compliant | Graph validation remains semantic authority; the new walk only enumerates nodes for disposable reports. |
| Q9-I5 | Node SDK/core/catalog registration and release assembly | intentionally retained | Declaration, catalog-cohort and executable verification are separate authorities with different inputs and lifecycle consequences; historical releases are compatibility fixtures. |
| Q9-I6 | API/contracts/infrastructure schema validators | already compliant | Transport, evidence and deployment validators remain at their own versioned boundaries; no equivalent checkpoint policy was found. |
| Q9-O1 | Worker capability types imported by production, preview, artifact and connection implementations | improved | Canonical neutral contract file; static import-boundary test prevents sibling consumers from importing the concrete production handler for capability types. |
| Q9-O2 | API authenticated workspace context | improved | One projector owns guard/session actor selection plus request/trace values. Feature error wrappers, raw socket/SSE behavior and traceparent remain local. |
| Q9-O3 | Quality/performance evidence owners | improved | Risk reporter owns review-to-test matching; benchmark comparator module owns the callable schema-v4 validator; full runner supplies run identity and gates output. |
| Q9-O4 | Supported package and wire exports | already compliant | No private refactor was added to a package root; existing public aliases and generated/browser contracts remain unchanged. |
| Q9-O5 | Small process/resource owners | already compliant | Lifecycle, operator, recovery, retention, object, queue, rate-limit and observability compositions retain explicit construction and close owners. |
| Q9-D1 | Coordinator/node-attempt persisted projection verifiers | improved | Two predecessor algorithms removed; one worker-local implementation serves both engines. |
| Q9-D2 | Six API controller actor/guard/request metadata variants | improved | Identical success projection shared; workflow feature error translation, node-test/connection raw error behavior, idempotency, SSE and transport extensions remain visible. |
| Q9-D3 | `workflowIntegrationUsage` and `compatibilityForGraph` nested walks | improved | One private stack-ordered node traversal; distinct missing-slot and unknown-definition policies and stable sorted outputs remain separate. |
| Q9-D4 | Benchmark producer, comparator and qualification consumer | improved | All call the same evidence validator; generation validates before exclusive output and removes incomplete owned output on failure. |
| Q9-D5 | Registry/release/executable compatibility lookalikes | intentionally retained | They validate different lifecycle stages and compatibility languages; merging would weaken separate authorities. |

### Conditional design comparisons

These comparisons use one representative change for each conditional family.
“Files” means the files a normal rule change would require, not every file that
was inspected during discovery.

| Family | Caller facts before → after | Invariant owner | Representative files / public surface | Failure, ordering and test impact | Query / allocation impact | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Q9-02 node-attempt input loading | One database method mixed ordered reads with scope proof, reconciliation and projections → the same method still owns one client and read order, then calls named private pure phases | Database loader owns snapshot/read order; private functions own permitted scope, upstream reconciliation, join, loop and collection proof | `node-attempt-run-store-inputs.ts`, its contract and unit/integration tests; no export added or removed | Existing validation precedence, stale attempt/fence errors and real consumer results stay fixed; focused bounded mocks plus real PostgreSQL node-attempt/For Each cases exercise the seam | Still one repeatable-read client and two application queries for 1/50/100 upstream values; private maps/sets are bounded by the existing input contract | **Extract private phases**: improves rule locality without hiding I/O or widening the database interface |
| Q9-03A persisted checkpoint codec | One long V1/V2 refinement block → version dispatch remains beside parse/serialize while private V2 branch, invocation, join, loop/budget/wait refinements are named and invoked in the original order | The database codec remains the sole stored-checkpoint language owner | `persisted-workflow-checkpoint.ts`, `persisted-workflow-checkpoint-refinements.ts` and parser tests; wire schema, errors and package exports unchanged | Canonical round trips, two-invalid-family precedence and historical V1/V2 fixtures retain exact results; consumers still see the generic persisted-data error | Same linear passes and bounded maps/sets; measured effective maxima are 1,996 invocations and 713 joins inside the 10,000-member stored-value envelope | **Extract private refinement families**: reviewability improves without a parser framework or cross-package policy |
| Q9-03B checkpoint/executable matcher | One 168-line topology-aware matcher → proposed per-family helpers would pass most checkpoint/executable context through several calls | Workflow engine matcher remains the only authority for executable topology, retained join forms and transition admissibility | Representative alternative would touch `operations.ts` plus checkpoint/branching/For Each suites and add no useful public surface | One-field drift and two-invalid controls show ordering is material; splitting would make precedence and “no transition returned” harder to audit while leaving the same tests | No query or meaningful allocation change; helpers would rebuild or forward the same maps and argument set | **Retain whole**: a deep, single authority is clearer than argument-moving helpers |
| Q9-05A authenticated API context | Six controller families repeated guard/session actor and request/trace projection → one small projector owns only the identical successful facts | Identity/workspace context projector owns common facts; guards, feature errors, traceparent, SSE and raw transport stay local | Six controller sources/tests plus `authenticated-command-context.ts`; no wire or package export change | Named cases cover guard precedence, session fallback, absent guard, request/trace propagation and invalid-actor feature behavior; SSE authorization/abort remains in its transport suite | No query, allocation or authorization-call change; one short object projection replaces clones | **Share the successful projection only**: error and transport differences remain explicit |
| Q9-05B nested workflow traversal | Two identity-report functions maintained equivalent nested stack walks → one private `workflowNodes` walk feeds both projections | Graph module owns enumeration; each report retains its missing-slot/unknown-definition and sorting policy | `graph/identity.ts` and graph-contract tests; no public graph iterator added | Nested, duplicate, permutation, missing-slot and unknown-definition cases preserve results and diagnostic policy | One bounded stack traversal per report as before; fewer duplicate traversal algorithms, no cache or retained state | **Share the private walk**: common enumeration moves once while report semantics remain separate |
| Q9-05 registry/release/executable lookalikes | Declaration, catalog release and executable checks consume different representations and act at different lifecycle stages → a proposed shared matcher would need a union language and mode switches | Node SDK registry, catalog release assembly and workflow executable validation each retain their existing authority | A merge would touch three packages, compatibility fixtures and exports; current design adds no surface | Their errors and compatibility consequences intentionally differ; current package and historical-release suites independently pin them | No repeated I/O; a shared normalized intermediate would allocate another representation without eliminating existing validation | **Retain separate**: similar identity syntax does not mean shared policy |
| Q9-02 purge locality control | One deep method visibly sequences restartable discovery, short control transactions, external I/O, fencing and checkpointing → three private durable-path functions would forward the same ledger/workspace/lease context | `WorkspacePurgeProcessor` remains the restartable state-machine owner | Proposed split would touch `workspace-purge.ts` and its cancellation/lease/partial-deletion/ambiguous-append/legal-hold tests; no public surface benefit | Existing order is the safety contract and real-service tests change together; extraction would obscure cross-stage precedence without isolating a reusable rule | Same bounded pages, locks, queries and external calls; additional closures/argument objects only | **Retain whole**: the prior Q08 decision remains supported by current locality and failure evidence |

### Q9-06 value-boundary matrix

| Boundary | Input domain and limits | Normalization / rejection | Owning consumers and proof |
| --- | --- | --- | --- |
| Workflow-model canonical JSON | Own plain JSON data; bounded graph/value contracts, UTF-8 byte accounting | Key ordering and `-0` canonicalization; rejects sparse/inherited arrays, cycles, prototypes, accessors, symbols, non-finite numbers, NUL/unpaired surrogates and inherited `toJSON` | Graph identity/checksum and canonical-json/graph-contract tests |
| Node SDK runtime JSON | Own plain JSON accepted at manifest/runtime-selected bytes, depth and members | Deep copy/freeze and browser/server parity; rejects hostile reflection, aliases/cycles outside its explicit language, custom-limit drift and executor schema mismatch | Registry public interface, browser boundary and executor tests |
| Database stored execution V1 | `inlineBytes=262144`, depth 64, members 10000; inline JSON or UUID artifact reference | Canonical serialization, deep freeze and persisted `-0` conversion; rejects SQL-incompatible keys, oversized values, accessors, cycles and malformed envelopes | Stored-value unit suite, execution-value PostgreSQL integration and node-attempt input integration |

The three contracts deliberately remain separate. Supported intersection values
flow node output → stored V1 value → loaded node input without identity or value
loss. Exact-bound/one-over, Unicode/escape, object/array/scalar, negative-zero,
prototype/accessor/symbol/cycle and `toJSON` cases are owned by the suites above;
PostgreSQL backstop behavior stays a persistence concern.

### Q9-06 failure and resource matrix

| ID / boundary | Disposition and owning evidence |
| --- | --- |
| Q9-S1 input/identity before database work | Improved loader exposes pre-checkout schema and permitted-scope proof; bounded mock proves no hidden/per-item client and real integration retains stale owner/fence rejection. |
| Q9-S2 transaction/projection compatibility | Already compliant: repeatable-read workspace client, exact release identities, generic persisted-corruption category and no transition returned for invalid executable/checkpoint relations. |
| Q9-S3 capability construction/use | Improved ownership only: production/preview optional fields, factory timing, signal/secret use and close responsibility are unchanged under handler/runtime suites. |
| Q9-S4 API authorization/context | Improved common success projection; guard-derived actor takes precedence, session fallback remains bounded, feature invalid-actor mapping and SSE reauthorization remain local and tested. |
| Q9-S5 JSON/value | Already compliant and intentionally different as recorded above; no universal serializer introduced. |
| Q9-S6 cancellation/stale dispatch | Already compliant: queue/worker/provider and connection-fence tests preserve durable uncertainty, abort propagation and no queue-derived terminal truth. |
| Q9-S7 object streams/artifacts | Improved after the rescan: artifact spooling, SSE producer/authorization/destination cleanup and streamed HTTP body ownership preserve sole and combined failures, attempt all ordered cleanup and avoid double-closing transferred iterators. Actual worker, API and integration-package consumer tests protect the paths. |
| Q9-S8 process/timer/pool owners | Improved after the rescan: migration, PostgreSQL sampling, startup smoke and temporary-directory validators preserve primary plus cleanup failures. Other lifecycle/operator/recovery/retention/queue/rate-limit/observability owners remain already compliant under their close suites; best-effort cancellation and nonrejecting heartbeat cleanup stay explicitly distinct. |
| Q9-S9 evidence/output cleanup | Improved: invalid benchmark output cannot be labeled complete; exclusive output is removed after owned write/close failure and cleanup errors remain aggregated. Run-linked integration evidence rejects missing/failed/skipped/wrong-file/wrong-test/wrong-source/wrong-run artifacts. |

### Evidence and bounded-work occurrences

| ID | Owner and disposition | Acceptance evidence |
| --- | --- | --- |
| Q9-E1 | Risk review evidence: improved | Standalone coverage stays `referenced-only`; the full runner regenerates the report after worker integration with exact run/candidate identity and requires all named tests to be passed in the correct file. |
| Q9-E2 | Benchmark evidence: improved | Callable schema-v4 validator is shared by actual producer, comparator and full runner; corrupt target SQL, marker, summary, raw round, environment and status cases fail. |
| Q9-E3 | CI/deployment/exercise evidence: already compliant | Existing gates keep local versus AWS-only and report versus deployment evidence distinct; Q9 does not claim live proof. |
| Q9-B1 | Upstream node inputs: improved/proved bounded | Populations 1/50/100 use one repeatable-read client and exactly two application queries (current attempt plus one `ANY` batch), never N reads. |
| Q9-B2 | Checkpoint invocations/joins: proved bounded, no optimization | Constraint-derived valid V2 invocation populations 1/998/1,996 and join populations 1/357/713 reach their effective maxima inside the 10,000-member stored-value envelope. Named maps/sets retain current semantics; no dominating waste was demonstrated. |
| Q9-B3 | JSON/value traversal: already compliant | Existing incremental bytes/members/depth tests and iterative traversals cover exact and one-over bounds without recursive-stack or accessor side effects. |
| Q9-B4 | Nested structured scope/graph traversal: proved bounded, no optimization | Constraint-derived materialized scope populations 1/13/26 use one client and exactly two application queries; the 256-byte durable invocation key is tighter than graph depth 32 for fully encoded paths. Graph-model populations 1/16/32 and engine checkpoint populations 1/999/1,997 reach their owning limits. Graph identity traversal retains one bounded stack walk. |
| Q9-B5 | Worker execution and benchmark subprocesses: already compliant | Attempt preparation uses bounded graph/checkpoint contracts; benchmark retains per-process RSS, operation counts, SQL counts, owned process-tree cleanup and explicit unavailable metrics. |
| Q9-B6 | API/catalog/contracts pagination and projections: already compliant | Existing limit schemas, bounded catalog release and keyset/member tests; no unbounded collection expansion found in affected consumers. |
| Q9-B7 | Artifact/provider/queue/rate-limit paths: already compliant | Existing streaming/body/concurrency/backpressure/rate-limit limits and composed tests; no Q9 change introduced buffering or per-item I/O. |
| Q9-B8 | Maintenance/process/infrastructure work | Intentionally retained/already compliant: bounded pages/leases/loops and explicit cleanup; the existing eight scenario benchmark remains operation-level evidence, not a universal capacity claim. |

## Q9-08 focused verification recipes

| Change | Fast feedback | Wider evidence |
| --- | --- | --- |
| Navigation/docs | `pnpm docs:check && git diff --check` | None unless import contracts changed |
| Input loader/checkpoint codec | Database typecheck; persisted checkpoint, stored value and Q9 bounded-work unit files | Node-attempt and For Each database integrations; composed worker attempt integration |
| Worker contracts/projection | Worker typecheck; handler, preview, runtime capability, coordinator engine, node engine and import-boundary files | Worker integration and compatibility/recovery cohorts |
| API context projection | API typecheck; six owning controller files and workflow-run SSE transport tests | API integration and SSE resilience cohorts |
| Graph traversal/value boundaries | Workflow-model/node-sdk typechecks; graph, graph-contract, canonical JSON and registry files | Historical retained workflow/executable and persistence consumers |
| Evidence plumbing | Node tests for risk reporter, quality runner, benchmark producer and comparator | Real full-run integration report, real schema-v4 artifact and source-stable qualification |
| Primary-plus-cleanup owners | Worker runtime capability, API SSE transport, HTTP executor and infrastructure cleanup tests; migration/PostgreSQL runner tests | Worker artifact integration, API SSE resilience, full local qualification cleanup cohort |

Focused tests retain normal package discovery. No predecessor security,
historical compatibility, transaction or integration tests were removed. The
seven existing mutation canaries remain the decisive policy perturbations;
Q9 adds negative evidence fixtures rather than duplicating those mutations.

## Ledger

| ID | Status | Decision / exact change | Acceptance evidence | Remaining limitation |
| --- | --- | --- | --- | --- |
| Q9-00 | complete | Frozen recoverable candidate and per-area/family scan | Hashes and matrices above; refreshed complexity/test map | Ignored baseline is local recovery evidence, not committed history |
| Q9-01 | complete | Current navigation and owner/test routes updated | Docs, architecture, format and diff checks pass on the final report-only delta | Q9 remains separate from production readiness |
| Q9-02 | improved; complete | Private named proof/projection families; SQL order unchanged | Typecheck, bounded unit probes and the 414-assertion real database cohort pass | No public pure-helper API by design |
| Q9-03 | improved/retained; complete | Codec families extracted; engine matcher retained as one authority | Parser, engine checkpoint, compatibility, recovery and full gates pass | Generic persisted error intentionally exposes no refinement order |
| Q9-04 | improved; complete | Neutral capabilities plus one projection verifier | Worker typecheck, owning suites, 43 worker integrations and compatibility/recovery cohorts pass | No public package export was added |
| Q9-05 | improved; complete | Common API projector and one nested graph walk, with distinct feature/report policies retained | All six controller owners pass 49 named assertions; API typecheck and 14 SSE transport cases pass; workflow-model identity/graph contract has 24 cases | Feature transport/error differences remain local |
| Q9-06 | improved; complete | Value/failure matrices reconciled; PostgreSQL sampler checkout ownership and explicit failure-state corrections close the review findings and analogous `undefined`-rejection sentinels | Actual worker artifact, API SSE, HTTP integration, PostgreSQL sampling/pool ownership, migration, process, smoke and temporary-directory paths have named sole/combined/non-Error proof, and the final qualification passes | Three AWS policy cases remain explicitly external |
| Q9-07 | improved; complete | Integration evidence is bound by its actual producer and exact run/candidate/test identity | All 24 reporter tests pass; the final full-run report records five executed integration branches against the exact passed worker artifact | Standalone reports remain referenced-only by design |
| Q9-08 | complete | Owning-interface tests and copyable recipes recorded | Focused controller, transport, worker, database, workflow and infrastructure commands pass; normal unit/coverage discovery includes the new cases | Durations are observations, not timing budgets |
| Q9-09 | improved; complete | One validator gates generation, comparison and qualification | Producer output open/write/close/cleanup combinations and corrupt schema-v4 fixtures pass; no partial output can be accepted | No invented performance threshold |
| Q9-10 | complete | Structural work/query counts plus constraint-derived small/intermediate/effective-upper populations | Database 8/8, workflow engine 1/1 and workflow model 24/24 pass; attributable memory is explicitly unavailable in shared-GC unit processes | No stable millisecond threshold claimed |
| Q9-11 | complete | Final semantic/reference rescan, review corrections and all 43 occurrence dispositions are reconciled | Run `2026-09-10t19-45-06-503z-96185-7c935fbc` held fingerprint `4198bffa…7747826` stable, passed all 21 required cohorts and produced the exact evidence below; final docs/format/diff checks pass separately | Deployment evidence remains outside this code-quality score |

## Occurrence-to-assertion evidence

Every one of the 43 non-overlapping occurrence records has an exact named
assertion or static gate. A row may cite more than one assertion when the
occurrence deliberately spans an owner and a real consumer. Parameterized
titles are reproduced exactly as declared in source.

| Occurrence | Disposition | Exact named assertion or gate |
| --- | --- | --- |
| Q9-N1 | improved | `artifacts/controllers.test.ts` — “projects absent and guarded workspace context through the owning controller”; the corresponding exact projection titles in `connections/controllers.test.ts`, `identity-workspace/controllers.test.ts`, `node-testing/controller.test.ts`, `workflow-authoring/controllers.test.ts`, and `workflow-runs/controllers.test.ts` |
| Q9-N2 | improved | `execution-import-boundaries.test.ts` — “keeps shared capability consumers independent of the production handler” |
| Q9-N3 | improved | `q9-bounded-work.test.ts` — “keeps %i upstream outputs in one batched lookup” and “selects the nearest declaration for %i nested structured scopes with one lookup”; `persisted-workflow-checkpoint.test.ts` — “accepts exact scoped For Each state and preserves loop-free V2” |
| Q9-N4 | improved | `validate-documentation.test.mjs` — “accepts local links, anchors, and aligned audit trees”; `operational-documentation.test.mjs` — “live operational guidance references executable policy and preserves historical evidence” |
| Q9-IO1 | improved | `q9-bounded-work.test.ts` — “keeps %i upstream outputs in one batched lookup” |
| Q9-IO2 | retained | `workspace-purge-foundation.integration.test.ts` — “does not hold a transaction while object erasure is delayed” and “repairs an ambiguous purge append and treats a concurrent claim as idle” |
| Q9-IO3 | compliant | `run-local-benchmark.test.mjs` — “rejects incomplete PostgreSQL role, pool, and plan evidence” and “isolates PostgreSQL workload totals and resets by database OID” |
| Q9-I1 | improved | `persisted-workflow-checkpoint.test.ts` — “canonicalizes Condition checkpoint V2 without reinterpreting V1”, “accepts a bounded settled Merge ledger in checkpoint V2”, and “rejects tampered loop scope, topology, ordinal, and budget state” |
| Q9-I2 | retained | `checkpoint-seam.test.ts` — “admits only checkpoint identities and timestamps accepted by persistence”; `executable-workflow-foreach.test.ts` — “schedules a For Each structured body by stable scoped ordinals” |
| Q9-I3 | improved | `coordinator-engine.test.ts` — “verifies the persisted projection before advancing the exact executable”; `node-attempt-engine.test.ts` — “verifies the pinned executable and executes Manual using only run input” |
| Q9-I4 | compliant | `workflow-graph-contract.test.ts` — “strictly rejects unknown schema versions, graph fields, settings, and nested fields” and “derives, deduplicates, and sorts nested provider operation connections” |
| Q9-I5 | retained | `registry.test.ts` — “selects only pinned definitions, executors, and policies”; `release-history.test.ts` — “pins every retained compatibility identity independently of manifests”; `retained-registry.test.ts` — “binds one exact executor to every definition in canonical order” |
| Q9-I6 | compliant | `run-local-benchmark.test.mjs` — “rejects weak, duplicate, or shell-shaped benchmark manifests”; `workflow-graph-contract.test.ts` — “strictly rejects unknown schema versions, graph fields, settings, and nested fields” |
| Q9-O1 | improved | `execution-import-boundaries.test.ts` — “keeps shared capability consumers independent of the production handler” |
| Q9-O2 | improved | The six controller projection assertions named under Q9-N1; `workflow-runs/controllers.test.ts` — “passes controller-owned SSE reauthorization and authorization to the stream use case” |
| Q9-O3 | improved | `report-risk-coverage.test.mjs` — “accepts only evidence produced by the matching qualification run”; `run-local-benchmark.test.mjs` — “validates and safely owns the actual producer output” |
| Q9-O4 | compliant | `node-sdk/test/package-contract.test.ts` — “publishes only browser-safe default/release exports and an explicit server subpath”; `node-catalog/test/package-contract.test.ts` — “keeps browser release metadata separate from server registry composition” |
| Q9-O5 | compliant | `run.test.ts` (retention) — “proves authority, drains completed work, records metrics, and closes”; `restore-before-serve.test.ts` — “proves dependencies in order and closes every resource”; `run.test.ts` (operator command) — “reports failures from both cleanup owners” |
| Q9-D1 | improved | The exact coordinator and node-attempt projection assertions named under Q9-I3 |
| Q9-D2 | improved | The six controller projection assertions named under Q9-N1, including each controller's exact invalid-actor assertion |
| Q9-D3 | improved | `workflow-graph-contract.test.ts` — “derives, deduplicates, and sorts nested provider operation connections” and “does not let projection metadata change compatibility identity” |
| Q9-D4 | improved | `run-local-benchmark.test.mjs` — “validates and safely owns the actual producer output” and its named “write failure”, “close failure”, “combined write and close failure”, and “cleanup failure is retained after write and close failures” subtests |
| Q9-D5 | retained | The exact registry/release assertions named under Q9-I5 |
| Q9-S1 | improved | `q9-bounded-work.test.ts` — “keeps %i upstream outputs in one batched lookup”; `retention-artifacts.integration.test.ts` — “does not mistake an undefined destructive-work rejection for success” |
| Q9-S2 | compliant | `checkpoint-seam.test.ts` — “admits only checkpoint identities and timestamps accepted by persistence”; `coordinator-engine.test.ts` — “rejects a projection column that disagrees with immutable envelope provenance” |
| Q9-S3 | improved | `node-runtime-capabilities.test.ts` — “closes partial capability assembly after a database authority failure” and “reports failures while closing owned capability resources” |
| Q9-S4 | improved | The six controller projection and invalid-actor assertions named under Q9-N1/Q9-D2; `sse-transport.test.ts` — “preserves authorization loss with producer cleanup failure” |
| Q9-S5 | compliant | `registry.test.ts` — “preserves hostile JSON property names as own data” and “enforces exact member and depth limits without recursive traversal” |
| Q9-S6 | compliant | `node-attempt-handler.test.ts` — “lets a dispatch-aware executor mark immediately before provider I/O”; `retention-transaction-cancellation.integration.test.ts` — “interrupts a blocked query, rolls back preceding writes and replaces the client” |
| Q9-S7 | improved | `node-runtime-capabilities.test.ts` — “rejects an undefined artifact operation failure and still removes its spool directory” and “preserves sole and combined spool file-close failures”; `run-event-stream.test.ts` — “preserves an undefined read rejection together with subscription cleanup failure” and “attempts every cleanup when synchronous failures follow a read failure”; `http-request.test.ts` — “preserves streamed body and iterator cleanup failures without double-closing ownership” and “closes an unclaimed response body when artifact writing rejects before iteration” |
| Q9-S8 | improved | `run-local-benchmark.test.mjs` — “PostgreSQL evidence releases a sampled client before ending its pool owner”, “PostgreSQL evidence drains and releases its waiter when sampling delay fails”, and “PostgreSQL evidence does not mistake an undefined rejection for success”; `migration-runner.test.ts` — “preserves an undefined migration rejection together with release failure” and “preserves ordered reset, unlock, release, and pool cleanup failures”; `postgres-telemetry.test.ts` — “does not mistake an undefined pool-end rejection for success”; retention `run.test.ts` — “preserves an undefined readiness rejection and still closes resources”; recovery `restore-before-serve.test.ts` — “preserves an undefined readiness rejection and still closes every resource”; operator-command `run.test.ts` — “preserves an undefined operation rejection while attempting both cleanups” |
| Q9-S9 | improved | `run-local-quality.test.mjs` — “managed command does not mistake an undefined cleanup rejection for success”, “qualification rejects failed, skipped, and incomplete required reports”, and “cleanup failure cannot leave inherited output pipes blocking the runner”; `run-local-benchmark.test.mjs` — “validates and safely owns the actual producer output” |
| Q9-E1 | improved | `report-risk-coverage.test.mjs` — “accepts only evidence produced by the matching qualification run”, “labels source-linked integration evidence as referenced-only”, and “rejects a review after source semantics change at the same location” |
| Q9-E2 | improved | `run-local-benchmark.test.mjs` — “validates and safely owns the actual producer output”, “records repeated operation latency, throughput, launcher cost and RSS”, and “fails closed when workloads omit declared operation measurements” |
| Q9-E3 | compliant | `run-local-quality.test.mjs` — “current CI supplies the shared local service and specialized-suite contract” and “qualification rejects missing service flags that could skip tests” |
| Q9-B1 | improved | `q9-bounded-work.test.ts` — “keeps %i upstream outputs in one batched lookup” |
| Q9-B2 | compliant | `q9-bounded-work.test.ts` — “measures small, intermediate and effective-upper V2 invocation populations” and “measures small, intermediate and effective-upper V2 join populations” |
| Q9-B3 | compliant | `workflow-graph-contract.test.ts` — “preflights exact and over-limit structured and arbitrary JSON depth”; `registry.test.ts` — “enforces exact member and depth limits without recursive traversal” |
| Q9-B4 | compliant | `q9-bounded-work.test.ts` — “selects the nearest declaration for %i nested structured scopes with one lookup”; workflow-engine `q9-bounded-work.test.ts` — “parses small, intermediate and effective-upper checkpoint populations” |
| Q9-B5 | compliant | `run-local-benchmark.test.mjs` — “records repeated operation latency, throughput, launcher cost and RSS” and “releases declared contention participants together and proves overlap” |
| Q9-B6 | compliant | `identity-workspace/controllers.test.ts` — “parses bounded member pagination and applies private cache policy”; `release-history.test.ts` — “retains every release cohort and staged/active lifecycle in canonical order” |
| Q9-B7 | compliant | `node-runtime-capabilities.test.ts` — “spools a bounded stream, persists pending metadata before upload, finalizes after verification, and cleans up” and “does not upload or leave spool data when the bounded stream overflows” |
| Q9-B8 | retained | `run.test.ts` (retention) — “drains another schedule batch immediately when capacity was reached”; `run-local-benchmark.test.mjs` — “samples a runner-owned fixture database separately from the configured base database” |

## Final source-stable qualification

The final `pnpm quality:local` completed as run
`2026-09-10t19-45-06-503z-96185-7c935fbc` from
`2026-09-10T19:45:06.549Z` through `2026-09-10T19:58:08.781Z` (782.232
seconds). HEAD was `0710322c3b541000d4c260c1143081278b95315b`; the dirty
candidate fingerprint was
`4198bffa19525ab87386c2a9e2a7e5ea4d07a5cd0bbfbf8645a0a912c7747826`
at both start and completion. All 21 required cohorts, including cleanup,
passed. The manifest SHA-256 is
`8745959f588711575cca31f0dec58f9ea0ff0cabe73f12f7b1531a939ddcd553`.
The lock cleared and no run-named service containers remained. The later
documentation reconciliation is report-only and is not part of that qualified
fingerprint.

The quality cohort passed formatting, generated contracts, lint, dependency
and import architecture, complexity, duplication, typechecks, cumulative diff
checks and 2,503 unit assertions. Real local-service reports passed 520
assertions: artifact store 5, queue 1, database 414, worker 43, API 33,
recovery 20, SSE resilience 1, worker transport resilience 1, API
compatibility 1 and database compatibility 1. The artifact-store report keeps
three AWS-policy-only scenarios as explicit external skips; no deployment,
live-provider or production claim is inferred from them.

The schema-v4 performance artifact is `complete`, contains all eight scenarios
with one warmup and five measured rounds, and records Node 24.15.0, pnpm
11.22.0, Apple M4/10 logical CPUs and 24 GiB memory. PostgreSQL evidence is
available with six representative plans and three sampler checkout-wait
observations. Its source inventory is
`a987d8eb52dce10c6b20c7ee7ac17d0116b75816e8b1c64dc2d36ede66ac4cd3`
over 1,531 files / 83 dirty entries; its internal manifest SHA-256 is
`e1d84678a7e0a6cd458d29a1b8071d37c708cd552366aaba3be177cc260e88a7`
and its file SHA-256 is
`7c11023eb213fb9b64221c5f522690fcd4be3e3fe4051e00f04aa2787bed1e93`.
Self-validation passed. Comparison with the compatible pre-Q9 artifact from
run `2026-09-10t10-48-49-281z-78496-16f7e49b` reports `sourceChanged: true`.
Candidate/baseline p50 throughput ratios were 1.0451 authoring, 0.9859 webhook,
0.9749 schedule, 1.0011 event visibility, 0.9812 bounded loop, 1.0126 artifact,
1.1246 foreground alone and 1.0338 retention-versus-foreground. Corresponding
p50 peak-RSS ratios were 0.99607, 1.00113, 1.01482, 1.00993, 0.99929,
0.99827, 0.99935 and 0.99673. Application and target SQL round trips were
identical except the schedule target observation decreased from 20,721 to
20,716. That five-query observation varies between runs; the structural
operation contract is unchanged. The five measured rounds do not justify a
universal timing or memory threshold, but these measurements and structural
counts demonstrate no attributable avoidable regression.

The schema-v3 worker integration evidence is bound to the exact run and
candidate fingerprint, source revision
`sha256:c0991f21f6f8f4f8499aea98e1a43e5fe725ad443e6aa895d88a7148d3f24d18`
and producer interval. All 42 suites and 43 tests passed. The raw result and
evidence-file SHA-256 values are respectively
`cfe3fabae0bf74600cbb2cb8a922b9d2ae48d000fd8e75d2098b0d6b5fcc9d11`
and
`5ed9aa914182c162939bb493253f0978965341ccd37d4bb608362f2d5967bdca`.

The final risk report generated at `2026-09-10T19:56:40.053Z` covers 130
selected files and 5,559 coverable lines, with 477 reviewed and zero unreviewed
selected branches. Five integration-classified branches—one
artifact-reference path, one HTTP-attempt path and three preview-delivery
paths—have `executed` evidence bound to the exact run ID, candidate
fingerprint, worker integration command, file and passed test title. Its
SHA-256 is
`61856ef892418a96426a7c19e1ec218cde542c1008f48b22822dfda20f64aee5`.

### Final rescan and occurrence reconciliation

The repeated final scan found no old application-private capability aliases,
no predecessor persisted-projection verifier, no controller-local clone of the
shared actor/request projection in the six migrated families, and no second
nested `workflowNodes` traversal. The persisted verifier has one definition
and two engine consumers; the authenticated projector has one definition and
all six intended controller consumers; the benchmark validator is called by
the producer, comparator and full runner. Imports from the concrete node
attempt handler are limited to its real engine/runtime dependencies. No new
applicable variant, unmigrated consumer or unclassified match was found.

The final awaited-cleanup semantic scan found and corrected every matching
primary-masking variant in the affected ownership family: run-event
subscription/iterator shutdown, artifact spool close/removal, migration
unlock/client release, PostgreSQL evidence clients, startup-smoke resources,
SSE authorization/producer/destination shutdown, streamed HTTP response-body
ownership and disposable validator directories. Each correction preserves the
owner's required order and attempts later cleanup after an earlier cleanup
failure. Remaining `finally` matches are intentionally different: byte-buffer
zeroing, listener removal, timer clearing and span termination are synchronous;
worker heartbeat outcomes capture rejection before cleanup; database reset,
backend cancellation and supervisor termination sites marked best-effort do not
replace the operation result; and invariant single-client release sites have no
second independently fallible cleanup or already pass the primary error to
their owning transaction helper. Test-only fixture teardown was not converted
into production policy, but the same shared temporary-directory helper is
covered with primary-plus-cleanup and non-Error cleanup controls.

| Improvement family | Discovered | Improved | Already compliant | Intentionally retained | Not applicable | Unfinished |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Naming | 4 | 4 | 0 | 0 | 0 | 0 |
| Ordered I/O | 3 | 1 | 1 | 1 | 0 | 0 |
| Invariant ownership | 6 | 2 | 2 | 2 | 0 | 0 |
| Interface ownership | 5 | 3 | 2 | 0 | 0 | 0 |
| Duplication | 5 | 4 | 0 | 1 | 0 | 0 |
| Safety and resources | 9 | 5 | 4 | 0 | 0 | 0 |
| Evidence | 3 | 2 | 1 | 0 | 0 | 0 |
| Bounded work | 8 | 1 | 4 | 3 | 0 | 0 |
| **Total** | **43** | **22** | **14** | **7** | **0** | **0** |

The same 43 non-overlapping occurrence records reconcile to the six assessment
sections: naming 4/4 improved; control flow 9 occurrences (3 improved, 3
already compliant, 3 retained); responsibilities 10 (7 improved, 2 already
compliant, 1 retained); safety 9 (5 improved, 4 already compliant); tests 3 (2
improved, 1 already compliant); and performance 8 (1 improved, 4 already
compliant, 3 retained). Every section has zero unfinished occurrences.

The final candidate includes the independent-review corrections for immediate
HTTP body-writer rejection, synchronous SSE cleanup throws and ordered
migration reset/unlock cleanup failures, together with the readability plan and
its immutable inventory. After the refreshed qualified fingerprint was
captured, only the exact run evidence below changed. That report-only delta
passed `pnpm docs:check`, `pnpm format:check` and `git diff --check` and remains
separate from the qualified code fingerprint.

### Final fixed-rubric assessment

| Section | Score | Evidence-backed assessment | Optional 10/10 stretch |
| --- | ---: | --- | --- |
| Naming and organization | **9/10** | Current navigation names policy, persistence, ownership and focused proof; changed-flow names are unambiguous and obsolete aliases are gone without blanket churn. | An independent reviewer-location exercise was not run. |
| Control flow and readability | **9/10** | Input loading and checkpoint parsing expose ordered named phases; retained purge and topology matcher flows preserve visible precedence rather than hide it behind argument-moving helpers. | No independent change exercise was recorded for every retained authority. |
| Responsibilities and interfaces | **9/10** | Capability consumers depend on a neutral contract, shared facts have one owner, API transport differences remain local and no private refactor became a speculative public seam. | No additional variation exercise is needed for Q9; broader API evolution remains ordinary future work. |
| Runtime, data and error safety | **9/10** | Value boundaries, pinned identities, transaction/fence/cancellation lifetimes, primary-plus-cleanup behavior and evidence failure states are explicit and pass through real consumers; no confirmed local safety defect remains in scope. | Existing deterministic combined-fault and boundary suites are strong, but Q9 did not add an independent mutation for every unchanged owner. |
| Tests and verification | **10/10** | Normal gates discover the new tests; focused recipes are copyable; existing seven canaries preserve sensitivity; producer and consumer share validation; selected integration reviews are automatically bound to exact executed results. | Stretch criteria are met locally; AWS-only execution remains a separate operational gate. |
| Local performance and resource discipline | **9/10** | Deterministic work-count probes cover valid populations and batching, the real eight-scenario artifact is validated, comparison is compatible and no avoidable regression or unbounded owner was demonstrated. | More repeated samples would be required before defining a stable regression budget; Q9 correctly does not invent one. |

These are the final Q9 code-quality scores. They neither raise nor lower the
separate production-readiness state.

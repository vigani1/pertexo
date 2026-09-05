# `@pertexo/workflow-engine` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 40 source files and all 8,484 physical source
  lines.
- **Test scope:** all 22 test/support files and all 8,451 physical test lines,
  direct API/worker/database consumers, worker/database integration coverage,
  root/package checks, CI, the implementation plan, and applicable ADRs.
- **Tooling scope:** `package.json`, both TypeScript configurations, the
  ordinary Vitest configuration, and the selected-source coverage
  configuration (5 files and 104 physical lines).
- **Granular certification:** every one of the package's 67 tracked files and
  17,039 physical lines was read in full. Every export and meaningful internal
  callable was reviewed for responsibility, callers, invariants, branch/error
  behavior, naming, readability, duplication, reuse, abstraction depth, test
  evidence, and applicable correctness, security, concurrency, cancellation,
  and performance concerns. Findings below are the complete identified set,
  not a top-N selection.
- **Architecture sources:** the authoritative backend plan; ADRs 001, 007, 008,
  010, 012, 016, and 017; the complexity-retention register; and the
  phase-terminology compatibility ledger.
- **Audit status:** granularly certified for the pinned tree.
- **Implementation status (2026-09-05):** eleven findings are implemented and
  verified, including completion of the WFE-004 source-hashed risk review;
  WFE-012 is intentionally retained with an exact breaking-release milestone.

## Remediation reconciliation

| Finding | Final status | Current evidence |
| --- | --- | --- |
| WFE-001 | Fixed | `8406d1e`; persisted facts use the shared bounded fact-window contract instead of generic executable JSON limits. |
| WFE-002 | Fixed | `5a7ed49`; each structured body is projected once and the traversal-count regression proves linear visitation. |
| WFE-003 | Fixed | `182f754`, `ce1c809`, `f8c3655`; completed outputs and persisted outcomes are normalized/indexed once, executable nodes are flattened once, invocation lookup reuses one prepared map, and failure/output preparation have purpose-named owners. |
| WFE-004 | Fixed; continuous gate | `667554a`, `5a71c1c`; all consequence-selected files and per-file floors are enforced. Fresh coverage is 90.56% statements (1,844/2,036), 85.32% branches (1,779/2,085), 93.62% functions (338/361), and 91.74% lines (1,766/1,925). Public compatibility-history boundary tests were added, and all 225 residual workflow-engine branches have exact source-hashed defensive, unreachable, or generated reviews. |
| WFE-005 | Fixed | `182f754`; current checkpoint construction/parsing enforce database-compatible engine IDs, UUID workflow IDs, canonical timestamps, and byte bounds. |
| WFE-006 | Fixed | `182f754`; checkpoint and executable public boundaries perform one hostile-object traversal before trusted parsing/normalization. |
| WFE-007 | Fixed | `5a7ed49`; scope equality/prefix identity has one engine owner and allocation-free structural helpers. |
| WFE-008 | Fixed; continuous model check | `132c8e1`; all 64 forward-edge subsets of a bounded four-node DAG prove deterministic plans, contiguous event sequences, once-only admission, and terminal conservation. |
| WFE-009 | Fixed | `5a7ed49`; duplicate loop/join declarations compare the complete durable scope and topology identity. |
| WFE-010 | Fixed | `3adf2e1`; the production facade is narrowed and the exact public surface is snapshot-tested. |
| WFE-011 | Fixed | `68485d8`; exact engine primitives have one purpose-named owner while trust-boundary-specific checks remain separate. |
| WFE-012 | Intentionally retained compatibility | The compatibility ledger now requires removal at the first deliberately breaking engine interface release after a zero-consumer scan and replacement release note; durable serialized identities remain unchanged. |

The workflow engine is one of the strongest architectural Modules in the
repository. It is a deterministic, mostly pure domain boundary between durable
database facts and database commit plans. It owns executable compilation and
verification, compatibility-release selection, checkpoint grammars, branch/
join/loop scheduling, retry and cancellation policy, persisted-observation
interpretation, attempt input resolution, and node execution admission. It
does not own queues, PostgreSQL transactions, provider clients, NestJS, clocks,
IDs, or telemetry exporters. That separation follows the plan and has high
Depth and Leverage.

The recent split from two thousand-line source owners into 40 purpose-named
files materially improved navigation. Most files now correspond to a grammar,
decision family, or transition phase. The remaining long functions are often
atomic parsers or state-machine stages whose order is correctness-sensitive.
They should not be divided merely to satisfy line counts. The appropriate next
work is to remove repeated traversals, index repeated lookups, centralize scope
identity, align external capacity contracts, and extend assurance around the
whole transition surface.

The most serious defect is not visible in the package's 226 passing tests. The
database deliberately accepts up to 10,000 persisted facts, with each event
bounded independently. `parsePersistedObservations` first feeds the entire
array through the generic one-MiB/10,000-member executable JSON normalizer. A
runtime probe of 6,000 valid-shaped `node.progress` facts—well within the
database row limit—was rejected as `observation_invalid` after exceeding the
generic member limit. Roughly 1,500 seven-field progress facts already exceed
10,000 members. A legal run backlog can therefore load successfully from the
database and then fail permanently at the engine boundary.

The stated coverage number also needs precise interpretation. CI enforces
91.02% branch coverage over a selected 13-file cohort. Full-source execution is
84.75% branches and 90.29% statements. Central modules such as coordinator
observation derivation, graph scheduling, executable validation/compilation,
persisted observation parsing, transition derivation/stops, runtime helpers,
and compatibility support are omitted from the threshold. The selected ratchet
is useful, but it is not package-wide coverage.

## Evidence collected

The review used complete source, test, fixture, package, and local-tooling file
reading; an export and internal-callable inventory; direct-consumer tracing;
implementation-plan and ADR comparison; package build/typecheck/lint/tests;
enforced and full-source V8 coverage; complexity/risk controls; focused
capacity and timestamp probes; and a nested structured-workflow timing probe.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/workflow-engine test` | 23 executable test files and 243 tests passed |
| Package build and typecheck | Passed in the repository pre-push gate |
| Repository lint, complexity, duplication, and dependency checks | Passed |
| Enforced selected-source coverage | 94.43% statements, 91.02% branches, 93.58% functions, 94.91% lines |
| Full `src/**/*.ts` coverage | 90.56% statements, 85.32% branches, 93.62% functions, 91.74% lines |
| Root risk report | 504 reviewed and 0 unreviewed uncovered branches repository-wide |
| Workflow-engine risk cohort | All 26 consequence-selected files are included; 225 residual branches have exact source fingerprints and branch-specific defensive, unreachable, or generated evidence |
| Persisted-fact capacity probe | 6,000 valid-shaped progress facts, 1,186,897 serialized bytes, rejected as `observation_invalid` for member overflow |
| Database contract comparison | Database accepts up to 10,000 persisted facts and 4,096 canonical bytes per fact |
| Checkpoint timestamp probe | `parseCheckpoint` accepted `resumeAt: "0"`; persistence requires ISO datetime |
| Nested scheduler projection probe | valid depth 14 took roughly 5–9 ms after warm-up; depth 15 was rejected by executable JSON depth before scheduling |
| Existing maximum-size tests | 300-node compilation under 2 seconds; wide checkpoint rejection under 1 second |
| Baseline package diff | Empty against the audited commit; findings describe that exact implementation |

Timing values are development-host diagnostics, not production SLOs. The
persisted-fact limit mismatch is structural and does not depend on timing. The
nested projection remains small at currently reachable depth, but the
implementation recomputes every nested body twice per ancestor and should be
made linear before depth or graph limits grow.

## Architecture, boundaries, and domain model

### Public production Interface

The root is server-only and exposes six capability groups:

- `advanceWorkflow`, `executeNodeAttempt`, and
  `resolveSingleNodePreviewInput` as production operations;
- checkpoint creation, parsing, reconstruction, limits, and checkpoint types;
- executable build/parse/verify/checksum and compatibility-release support;
- branch, join, loop, retry, wait, cancellation, and transition primitives;
- stable engine errors, status vocabularies, observations, events,
  admissions, and transition plans; and
- a deprecated runtime-policy compatibility alias.

The primary operations are deep: callers provide facts and receive immutable
plans without knowing traversal, grammar, retry, or scheduling details. The
low-level policy and transition exports are much shallower and largely unused
outside this package. Reducing those exports would make the supported Interface
clearer without changing implementation ownership.

The `./testing` entry adds raw scheduler-state parsing and direct deterministic
advancement. Keeping that seam server-only and separate from production is
correct. It lets unit tests characterize the state machine without making raw
scheduler state a production authority.

### Dependency direction

The engine depends only on Node crypto/util, `@pertexo/node-sdk`, and
`@pertexo/workflow-model`. It receives registry releases, executable/checkpoint
bytes, persisted facts, resolved output material, and execution ports. It emits
plans or calls a node registry. It has no database, queue, HTTP, provider, or
framework dependency.

The API builds initial checkpoints and executable artifacts. The worker
verifies artifacts, advances workflows, prepares node attempts, and resolves
preview inputs. Database adapters persist and reload the engine's durable
contracts. This direction is correct: infrastructure knows the engine; the
engine does not know infrastructure.

The weak point is contract duplication at the database seam. Both packages
parse checkpoint shapes and define observation capacities. Their policies are
not generated from one shared persisted contract, and they have drifted in
timestamp, identity, and aggregate-size admission. This is not a reason to move
SQL into the engine. It is a reason to establish one serializable contract and
one capacity vocabulary at the seam.

### Determinism, concurrency, and side effects

Transition functions consume caller-provided timestamps and deterministic
hash identities; they do not call `Date.now`, `Math.random`, or external I/O.
Graph, invocation, event, branch, and loop ordering is explicit. Retry jitter
is derived from stable SHA-256 input. Provider idempotency keys are stable over
run, invocation, and pinned operation identity.

Optimistic concurrency is correctly outside the package: plans carry expected
checkpoint revision and event sequence for the database compare-and-swap. A
recomputed plan is deterministic, and post-commit redelivery does not create a
second logical attempt. The engine does not pretend to provide exactly-once
external effects; side-effect class and possible dispatch drive retry versus
`outcome_unknown`.

Cancellation is checked before and after workflow advancement and during input
mapping. A node result that completes concurrently with cancellation is
preserved as confirmed success, which is intentional and tested. Durable
running effects are reconciled by the worker/database layer rather than
silently rewritten by this pure Module.

### Recommended internal shape

The present folders are flat, but file names already form coherent conceptual
groups. A low-churn directory move is not urgent. If these areas change
materially, the natural ownership layout is:

```text
src/
  executable/              build, boundary, validation, compatibility, graph index
  checkpoint/              public parser plus V1/V2 grammar and shared JSON admission
  transition/              state, observation application, derivation, stops, plan
  scheduling/              graph readiness, join/loop/retry/wait policies
  observations/            persisted parser and coordinator-derived facts
  attempts/                input preparation and node execution
  operations.ts            three production orchestration entry points
  types.ts                 stable public domain vocabulary
  index.ts
  testing.ts
```

Do not create classes around these pure functions and do not create one file per
tiny helper. First add a prepared execution index containing nodes, edges,
scopes, and structured bodies, then pass it through the operation. That single
deepening seam can remove repeated recursive projections, repeated `find`
scans, and stringified-scope equality while keeping the public operation small.

## Complete production-code review

### `src/server-only.ts`

The four-line Node guard and package `browser: false` mapping correctly keep
crypto and server execution out of browser bundles. The redundancy is useful
defense in depth and has negligible cost.

### `src/index.ts`

The barrel is explicit and type-oriented, with no wildcard runtime export. It
correctly exposes primary operations and durable types. It also exports many
package-internal policy primitives whose only non-test external use is
`invocationKey`. See WFE-010. The deprecation comment for the Phase 3 alias is
accurate and lint-scoped.

### `src/testing.ts` and `src/testing-graph.ts`

The testing entry parses unknown checkpoints/graphs before direct transition
use and rejects simultaneous graph and scheduler-state inputs. It provides a
valuable characterization seam. `SchedulerGraph` deliberately omits executable
identity and should remain testing-only. Throwing a plain `Error` for mutually
exclusive test inputs is acceptable at this non-production boundary, though a
`WorkflowEngineError` would be more consistent.

### `src/types.ts`

Run, node, and attempt status tuples create useful closed unions. The
observation union distinguishes external facts from coordinator-derived branch,
join, and loop facts. Output references carry only durable locators, not values.
Checkpoint V2 extends V1 additively with structured scope and branch selection.
Event/admission/transition-plan shapes are explicit and immutable.

The 303-line file remains cohesive as the package vocabulary. Splitting every
type by consumer would make the state machine harder to review. It contains no
conditional-type cleverness or unsafe broad `any`.

### `src/errors.ts`

One stable `WorkflowEngineError` with a closed code union is appropriate. Error
messages are diagnostic while callers can branch on `code`. The package avoids
leaking arbitrary executor exceptions through operation boundaries.

### `src/ordering.ts`

`compareOrdinal` provides locale-independent stable ordering. The same function
is independently defined in executable foundation; one owner would be clearer.
It should remain a package-local primitive.

### `src/executable-foundation.ts`

Runtime policy pins, executable limits/types, process authenticity, identity
comparison, deep freeze, canonical digest, and global-policy validation form
the foundation for immutable executable identity. `WeakSet` authenticity
prevents callers from casting an unverified envelope into a compiled value in
the same process. Canonical SHA-256 domains avoid cross-purpose collisions.

`freezeExecutable` is iterative, cycle-aware, and suitable after JSON
admission. The freeze is justified because the checksum/compatibility promise
depends on stable in-process identity. Do not remove it without mutation tests
and profiling.

`PHASE3_RUNTIME_POLICIES_V1` is an unused deprecated public alias retained by an
explicit compatibility ledger. It is not current implementation terminology.
Define its removal release instead of retaining it forever. See WFE-012.

### `src/executable-validation.ts`

`record`, `exactKeys`, and `assertSafeExecutableJson` reject proxies, accessors,
symbols, cycles, sparse arrays, inherited fields, non-plain objects, non-finite
numbers, excessive depth/members/bytes, and malformed surrogate accounting
before canonical allocation. This is careful hostile-input handling.

Identity, global-policy, policy-list, side-effect, retry-class, and immutable
manifest projection parsing preserve only executable behavior. The explicit
switch from manifest retry classes to engine side-effect classes is preferable
to type-level magic.

`normalizeBoundedEngineJson` calls `assertSafeExecutableJson` and then
canonicalizes. Several callers perform an explicit assertion immediately
before calling it, doubling a full traversal. Keep one boundary scan per
unknown value. See WFE-006.

### `src/executable-graph-validation-index.ts`

The graph index centralizes nodes, incoming/outgoing edges, node-port lookups,
adjacency, and Parallel/Merge relationships. It is a good response to former
repeated scans and has high Leverage. Map values are sorted for deterministic
consumers. This concept should be extended into runtime preparation rather than
duplicated as ad hoc maps in scheduler operations.

### `src/executable-graph.ts`

`executableNodes` and `executableEdges` recursively flatten the verified graph.
Depth is bounded, so recursion is safe under the current executable limit.
`allExecutableNodes` in compilation duplicates the node traversal exactly;
retain one internal owner. Repeated callers should receive a prepared array/map
instead of flattening the same executable again.

### `src/executable-graph-boundary.ts`

Raw executable node/graph reading separates untrusted-envelope structure from
authoring-graph reconstruction. `authoringNode`/`authoringGraph` deliberately
drop executable-only pins before workflow-model semantic validation.
`validatePin` checks admission/current manifests, lifecycle, ABI, side-effect
class, config version, executor ownership, policies, and retained execution
rules. Recursive validation preserves For Each structure.

The module correctly relies on workflow-model for authoring topology and then
adds runtime pin compatibility. It should not independently execute arbitrary
config schemas during retained verification; the immutable behavior and
checksum are the durable authority.

### `src/executable-compilation.ts`

Compilation resolves manifests/executors, verifies expression policies and
ports, prevents branch reconvergence, pairs Parallel/Merge, canonicalizes nodes
and edges, computes selection identity, and builds the final checksum. The
graph validation index avoids many former repeated searches.

`assertBranchesDoNotReconverge` is long but represents one topology policy and
is readable in stages. Its local descendant traversal is appropriate for the
bounded publish path. Compilation's `allExecutableNodes` duplicates the runtime
flatten helper, and `buildBoundary` reparses the envelope it just constructed.
That round trip is expensive but useful as proof that emitted artifacts satisfy
the public parser; keep it unless measured, but remove duplicate pre-scans
inside the parser.

### `src/executable-boundary.ts`

`parseBoundary` verifies JSON safety, exact envelope keys, schema versions,
admission provenance, current/admission releases, runtime policies, empty V1
migration list, authoring semantics, executable pins, canonical order, and
selection fingerprint. `parseWorkflowExecutableV2` deep-freezes the result;
`verifyWorkflowExecutableV2` additionally checks checksum and registers process
authenticity.

The boundary currently validates the envelope twice before allocation because
`parseBoundary` calls `assertSafeExecutableJson` and then
`normalizeBoundedEngineJson`, which repeats it. `execution` is likewise scanned
then normalized/scanned again. See WFE-006.

### `src/executable-compatibility.ts`

Engine policies are composed into node-catalog releases without allowing the
catalog to impersonate engine policy ownership. Rolling support is bounded to
current/target, while retained historical support is explicitly separate.
History requires contiguous successor epochs and verifies reconstructed
fingerprints. Resolution uses exact epoch/fingerprint pairs.

This is a deep and correct compatibility Module. Full-source branch coverage is
75%, and it is absent from enforced coverage despite governing deploy/readiness
behavior. Add missing negative succession/fingerprint and normalization cases.

### `src/executable-workflow.ts`

The facade re-exports executable capabilities and hides internal file layout.
It is a good stable import seam. The deprecated alias is intentionally
suppressed at this one compatibility export.

### `src/checkpoint-shared.ts`

The checkpoint JSON scanner is careful and non-recursive. It reproduces exact
JSON byte accounting without invoking `toJSON` or proxy/accessor traps and
bounds depth, members, array items, hidden properties, and symbols. Shared
parsers validate output locators, invocation states, structured scope, and join
ledgers. Canonical UUIDs and stable sorting protect persisted identity.

`parseInvocation` accepts any `Date.parse`-recognized timestamp rather than the
canonical ISO format required by persistence. Several identity strings are
only non-empty here but have tighter database lengths/patterns. This makes the
engine parser less authoritative than its storage adapter. See WFE-005.

### `src/checkpoint-v1-join.ts`

The V1 join parser is an atomic grammar decision. It verifies exact keys,
scope, policy/count bounds, unique/sorted ledger branches, terminal settlement,
selected arrivals, and unsatisfied reason precedence. The 201-line function's
branches are domain rules, not accidental abstraction debt. Existing coverage
is 96.59% branches.

### `src/checkpoint-v1-loop.ts`

The loop parser validates scope, topology identifiers, collection reference and
checksum presence, concurrency/iteration bounds, cursor, disjoint active/
terminal ordinals, and contiguous admission accounting. Its 100% branch
coverage and explicit grammar justify retaining it as one parser.

`collectionChecksum` is only checked non-empty here; executable/physical
validation establishes meaning later. A shared persisted-contract schema would
make that layered trust more obvious.

### `src/checkpoint-v1.ts`

The V1 boundary validates top-level identity/state, sorts invocations/joins/
loops, rejects duplicate keys, reconstructs ready state, verifies join/loop
parent relationships, and requires ordinary waits to have due metadata. It
retains legacy synthetic loop representations deliberately.

Calling `assertBoundedCheckpointJson` here after `parseCheckpoint` already did
the same full scan is redundant. V2 calls this function internally after its
own scans, so a V2 parse performs three bounded traversals. See WFE-006.

### `src/checkpoint-v2.ts`

V2 adds exact structured invocation scopes, branch-selection validation, and
initial iteration-budget accounting while reusing the V1 grammar. The additive
strategy is appropriate for persisted compatibility. Canonical invocation keys
bind branch and iteration paths.

The implementation strips scope fields, reparses the V1 projection, and then
reattaches V2 invocations. This preserves one semantic owner but makes repeated
boundary traversal particularly costly. Separate “already bounded” grammar
helpers would retain reuse without rescanning.

### `src/checkpoint.ts`

The public dispatcher identifies V1/V2, normalizes unexpected exceptions into
stable engine errors, reconstructs ready keys, and creates empty checkpoints.
The API is appropriately small.

`createCheckpoint` validates iteration/event numbers but accepts empty or
oversized engine/workflow identities that the database rejects. `parseCheckpoint`
accepts noncanonical resume timestamps. Constructors and parser should produce
exactly persistence-admissible values. See WFE-005.

### `src/persisted-observation-parser.ts`

The parser has strong exact-key, canonical timestamp, UUID, attempt-number,
status, wait/output, failure-kind, and safe-error-code validation. Its staged
switch keeps each observation grammar local. Returning a closed parsed union is
good TypeScript and makes unsupported kinds fail closed.

The file duplicates UUID/timestamp primitives used in checkpoint/database
contracts. More importantly, aggregate admission happens before this parser
and uses generic executable limits rather than the database's fact capacity.
See WFE-001.

### `src/persisted-observations.ts`

This module deduplicates sequenced facts, rejects reordering/conflicts/gaps,
matches stale facts against checkpoints, separates deadlines/due resumptions/
attempt failures, fences attempt numbers, and maps physical facts into semantic
observations. These are central recovery semantics.

Its full-source branch coverage is only 63.87%, the lowest meaningful
production file, and it is excluded from enforced coverage. The initial whole-
array normalizer causes WFE-001. Repeated checkpoint `find` operations can be
replaced with an invocation map without changing semantics.

### `src/coordinator-observations.ts`

The three exported functions derive branch selection, For Each declaration/
completion, and Parallel/Merge observations only from matching persisted
outcomes and completed material. They bind sequence, attempt, invocation,
output reference, pinned node type/config, scope, collection checksum, branch
paths, and terminal status. Keeping these derived facts inside the engine is
correct.

This 539-line module repeatedly normalizes the same observation and completed-
output arrays in separate functions. Branch derivation performs `some` over all
persisted facts for each completed item and flattens executable nodes inside
the item loop. For Each performs another persisted `find`; Merge repeatedly
filters all projected invocations per branch. At allowed sizes these become
quadratic. Build indexed facts/nodes/scopes once in `advanceWorkflow`. See
WFE-003.

### `src/graph-scheduler.ts`

Configured Condition/Switch/Parallel ports and concurrency are derived from
pinned config with exact V1 patterns. `deriveReadyNodes` builds local node,
invocation, predecessor, and adjacency indexes; applies branch selections;
tracks blocked/skipped paths; stops traversal at Merge; and emits canonical
scoped invocation identities. The code is complex because branch semantics are
complex, not because it uses the wrong abstraction.

Scope selection uses repeated `JSON.stringify` equality and prefix loops.
Branch/Parallel loops repeatedly filter all graph edges and recompute configured
ports. Extend the prepared graph/scope index rather than splitting the state
machine into many tiny helpers. See WFE-003 and WFE-007.

### `src/scheduling.ts`

Join settlement, branch disposition, loop reservation/admission/completion, and
invocation-key construction are explicit pure decisions. Join policy correctly
waits for every branch disposition before settling, preserves unsafe failure
precedence, and chooses arrivals deterministically. Loop state reserves the
entire collection against the run-wide budget before admitting bounded batches.

Several functions are public despite no production external consumer. Their
runtime validation is correspondingly partial; for example, `createLoopState`
assumes valid identity/reference inputs and `invocationKey` accepts arbitrary
strings/ordinals. Keep them internal or specify a complete public boundary.

### `src/retries.ts`

The fixed V1 retry policy, decision union, deterministic jitter, unsafe possible-
dispatch handling, attempt ceiling, and stable provider key correctly encode
ADR 007. Mutation-canary tests enumerate high-consequence decisions. Full
coverage is 100%.

`decideRetry` is exported with an arbitrary `RetryPolicy` input but performs no
complete runtime validation of delay/attempt values. Production uses
`resolveRetryPolicy`, so this is an API-depth issue rather than a current bug.

### `src/runtime.ts`

Durable-wait and cancellation helpers express useful policy, but no production
consumer outside the package uses them. `planDurableWait` says “valid ISO” while
using permissive `Date.parse`, preserves the original noncanonical value, and
does not validate invocation identity. Either internalize it or align it with
the canonical persisted timestamp contract.

`CancellationDecision` includes `stop_scheduling`, but
`decideCancellation` never returns that variant. This dead union arm suggests
the shallow public helper and actual transition engine have drifted. Remove the
variant or implement/document its owner.

### `src/transitions.ts`

Explicit run/node/attempt adjacency tables are easy to audit. Terminal states
cannot resurrect. Mutation tests fail for added or removed transitions, giving
strong policy evidence. Keeping tables local is better than a generic state-
machine framework.

### `src/operation-values.ts`

The small JSON record/exact-key helpers preserve operation-specific error codes.
They resemble executable/checkpoint helpers but have different admitted types
and error semantics; consolidation should not erase those distinctions. Error
text currently says “observation fields” even when used for attempt input,
which is a minor diagnostic naming issue.

### `src/node-attempt-input.ts`

The module locates the containing graph, verifies structured ancestors and
invocation identity, accepts only direct-upstream completed outputs, supports
legacy unscoped input only outside loops, validates collection checksum/ordinal,
and constructs `{item, ordinal}` structured inputs. This is a deep and useful
attempt-admission boundary.

Recursive node lookup and ancestor lookup traverse the executable separately,
then direct upstream is recomputed. A prepared executable index would improve
Locality and performance. Coverage is 86.04% branches, with untested malformed
scope/proof combinations remaining.

### `src/operations.ts`: workflow advancement

`advanceWorkflow` authenticates executable identity, parses and cross-checks the
checkpoint, parses persisted facts, derives branch/loop/merge observations,
resolves attempt failures through pinned retry policy, calls the deterministic
transition core, and attaches provider idempotency keys. It checks cancellation
before and after the synchronous-heavy operation.

`assertCheckpointMatchesExecutable` is long but owns one necessary defense-in-
depth comparison between persisted state and immutable executable topology.
Keep its semantic sequence. It repeatedly flattens/finds nodes and compares
scope arrays via JSON serialization; pass a prepared index and exact scope
helpers instead.

`schedulerState` recursively calls `projectGraph(node.structured.body)` twice
for every structured node, embedding nested `structuredBodies` and then
flattening them again. Work/allocation grows approximately twice per nested
level. Current executable depth bounds keep the measured maximum modest, but
the algorithm is needless and fragile. Compute the child projection once and
store each structured body exactly once. See WFE-002.

### `src/operations.ts`: mapping, preview, and attempt execution

Mapped input resolution uses only run input, exact direct-upstream outputs, and
nearest structured input; it passes cancellation through expression resolution
and re-bounds aggregate output. Trigger nodes correctly receive run input.
Preview uses the same production ValueSource path without fabricating an
executable.

`executeNodeAttempt` verifies authentic executable identity and exact
invocation scope before registry execution. It passes the caller signal and
preserves typed `NodeExecutorFailure`; arbitrary errors become a safe engine
error. The lack of a post-execution abort assertion is intentional: a provider-
confirmed result that wins the race is preserved and tested.

### `src/transition-decisions.ts`

Admission respects run-wide and nested Parallel concurrency while terminal run
status gives `outcome_unknown` precedence over cancellation/deadline/failure.
The functions are pure and cohesive. `graphIncomplete` callers must account for
structured control via loops; existing loop tests demonstrate that integration.

### `src/workflow-transition-state.ts`

This module owns mutable transition state vocabulary, event mapping, output
equality, observation order, join/loop declaration equality, scheduler node
lookup, loop consistency, and event construction. Mutable state is confined to
one transition and converted back through the checkpoint parser before return.
That is good controlled mutability.

Iteration-path equality is repeatedly implemented with `JSON.stringify` here
and elsewhere. `sameLoopDeclaration` omits scope and body topology;
`sameJoinDeclaration` omits scope/join identity. Because replays retain existing
state, this does not mutate to the conflicting value, but it fails to reject all
conflicting declarations. See WFE-009.

### `src/workflow-transition-observations.ts`

Observation application is split by join, branch, loop, invocation, control,
and due-resumption ownership. Existing terminal results are idempotent only
when status/output agree. Transitions run through adjacency assertions.
Coordinator-derived events are emitted only when required, while already
persisted external facts advance the cursor without duplication.

The 527-line file is cohesive and should remain ordered. The enforced cohort
includes it, but full branch coverage is 89.47%; the root risk ledger documents
remaining infeasible/defensive branches. Add public behavior cases for any
new branch rather than direct mutation of private state.

### `src/workflow-transition-derived.ts`

Readiness, loop-body readiness, join settlement, exhausted-loop completion, and
new iteration admission occur in an explicit deterministic order. That order
is a core invariant. The module correctly prevents admissions after cancel or
deadline and materializes synthetic coordinator node events.

It has 81.08% full-source branch coverage and is omitted from the enforced
cohort despite being central scheduling logic. Add it to the risk surface. The
conditional inferred type used for the loop parameter is harder to read than
importing `LoopState` directly and provides no extra safety.

### `src/workflow-transition-stops.ts`

Cancellation/deadline stop nested loop bodies, reconcile active ordinals, stop
loop controls, then settle remaining pending/ready/waiting invocations with the
documented precedence. Running invocations are left for durable reconciliation.
This sequencing correctly avoids inventing external outcomes.

Iteration scope is found by scanning every invocation and stringifying arrays
for every active ordinal. Index by scope key. This file has 82.75% branch
coverage and is absent from the enforced coverage cohort.

### `src/workflow-transition-plan.ts`

Plan building bounds admissions, transitions selected ready nodes to running,
increments attempts, derives terminal/waiting run status, assigns event
sequences after consumed facts, reparses the produced checkpoint, and emits
node-run admissions separately from attempt capacity. The final parse is a
valuable invariant check.

The plan computes graph completeness with repeated scans and reparses a V2
checkpoint through multiple full JSON traversals. Indexing and already-bounded
grammar entry points can reduce cost without weakening the final invariant.

### `src/advance-workflow.ts`

The orchestrator validates admission count and persisted cursor arithmetic,
initializes one mutable transition, establishes external/coordinator observation
ordering, then applies, derives, stops, and builds. The 142-line function is an
excellent small public facade over deeper internals.

It assumes `occurredAt`, due resumptions, and typed testing observations are
already valid unless they came through the production persisted parser.
Production supplies canonical database facts; the testing entry should document
this trusted typed boundary.

## Tests, coverage, and CI

### Package and local-tooling assessment

- `package.json` exposes only the intended root and `./testing` subpath, marks
  the package server-only for browser resolution, publishes compiled output,
  and keeps runtime dependencies limited to `node-sdk` and `workflow-model`.
  Its build, typecheck, test, and coverage commands follow repository
  conventions; no package-local dependency or script is obsolete.
- `tsconfig.json` correctly extends the shared production configuration,
  narrows compilation to `src`, and writes declarations and JavaScript to
  `dist`. `tsconfig.test.json` adds the test tree without weakening production
  compiler settings. There is no package-specific compiler escape hatch.
- `vitest.config.ts` is a deliberately minimal Node test configuration.
  `vitest.coverage.config.ts` uses V8 and exact ratcheted thresholds, but its
  13-file include is narrower than the consequence-bearing implementation;
  that is the assurance gap recorded as WFE-004, not a Vitest misuse.
- Tooling is TypeScript rather than ad hoc shell or `.mjs`; configuration is
  small, local, and non-duplicative. The package lint passed when run in
  isolation with an 8 GiB Node heap. A simultaneous test/build/coverage/lint
  diagnostic exhausted the default 4 GiB lint process, which is an artifact of
  that intentionally concurrent diagnostic rather than the repository's
  sequential pre-push or GitHub workflow.

### Test-file assessment

- `package-contract.test.ts` proves production and testing entry points remain
  server-only. It should also snapshot intentional public exports if WFE-010 is
  addressed.
- `checkpoint-seam.test.ts` thoroughly tests V1/V2 dispatch, legacy loops,
  exact keys, scopes, due metadata, bytes, members, proxies, accessors, symbols,
  cycles, and `toJSON` traps. It is meaningful hostile-input coverage.
- `checkpoint-risk-branches.test.ts` covers escape/surrogate byte accounting,
  negative zero, state metadata, join/loop inconsistencies, optional flags,
  unsupported roots, ordering, and event sequence branches.
- `branch-join-scheduling.test.ts` covers all/any/count settlement, missing/
  skipped behavior, typed unsatisfied joins, and replay conflicts.
- `foreach-scheduling.test.ts` covers pinned collection identity, batch
  admission, empty and over-limit collections, nested budget exhaustion, and
  stable scoped keys.
- `retry-wait-cancellation.test.ts` covers deterministic backoff, retry bounds,
  unsafe ambiguity, adapter recommendations, durable wait, cancellation
  reconciliation, and terminal non-resurrection.
- `retry-policy-mutation.test.ts` enumerates every high-consequence retry policy
  mutation and incomplete provider-key identity. This is stronger than ordinary
  example testing.
- `transition-policy-mutation.test.ts` detects every added/removed run, node,
  and attempt transition.
- `advance-workflow-transitions.test.ts` covers malformed graphs, same-turn
  successor derivation, deterministic recomputation, exact redelivery,
  conflicting outcomes, waits/resume, cancellation, terminal precedence,
  waiting runs, and join settlement.
- `advance-workflow-branching.test.ts` covers deterministic scoped Condition,
  Switch, Parallel, admission caps, invalid selections, and checkpoint V2
  persistence.
- `advance-workflow-risk-branches.test.ts` exercises admission/cursor bounds and
  public defensive cases.
- `workflow-transition-risk-behavior.test.ts` reaches public join, loop,
  control, due, ordering, replay, and error paths without mutating private state.
- `executable-workflow-identity.test.ts` covers port/reconvergence rules,
  Parallel/Merge pairing, release overlap/history, checksums, canonical order,
  immutable behavior, lifecycle, retained execution, tampering, structured
  graphs, policies, exact byte limits, and 300-node performance.
- `executable-workflow-inputs.test.ts` covers output locator identity, mapping,
  trigger input, cancellation race semantics, preview parity, and aggregate
  mapped-input overflow.
- `executable-workflow-outcomes.test.ts` covers pinned side effects,
  idempotency keys, retries, cancellations, unsafe unknown outcomes, malformed
  failures, persisted event cursors, and derived event sequencing.
- `executable-workflow-controls.test.ts` covers persisted waits, due ordering,
  cancel/deadline precedence, active reconciliation, ordinary waiting stops,
  and node-run versus attempt admission capacity.
- `executable-workflow-branching.test.ts` covers production executable/
  checkpoint branch identity, persisted output-derived selections, Parallel
  fan-out, and direct Merge branches.
- `executable-workflow-foreach.test.ts` exercises the complete ordinary For Each
  lifecycle, cancellation, tampering, bounds, skipped paths, and concurrency.
- `executable-workflow-foreach-part-2.test.ts` covers nested loops, structured
  input/upstream execution, and testing-entry separation.
- `operation-risk-branches.test.ts` covers operation identity bounds, early
  abort, disabled nodes, completed-output forms, optional runtime, collection
  proofs, and malformed preview inputs.
- `executable-workflow.fixtures.ts` and
  `support/advance-workflow.fixture.ts` are owner-local test builders. Their
  extraction reduces duplication and remains readable; they are not fake
  production abstractions.

The tests are useful: they target state transitions, persisted truth,
idempotency, malformed inputs, and recovery behavior rather than checking only
constructors or snapshots. Database/worker integration suites also execute the
engine with PostgreSQL, queues, redelivery, process death, retries, branching,
and For Each cancellation. The main missing technique is generative/model-based
sequence testing.

### Coverage interpretation

The enforced configuration includes 13 files and omits 27. Some omitted files
are barrels/types, but many own runtime decisions. Selected coverage is 91.02%
branches; full-source coverage is 84.75%. Particularly relevant full-source
branch results are:

| File | Branch coverage |
| --- | ---: |
| `persisted-observations.ts` | 63.87% |
| `executable-validation.ts` | 70.49% |
| `runtime.ts` | 73.33% |
| `executable-compatibility.ts` | 75.00% |
| `operations.ts` | 78.94% |
| `workflow-transition-derived.ts` | 81.08% |
| `graph-scheduler.ts` | 81.64% |
| `workflow-transition-stops.ts` | 82.75% |
| `coordinator-observations.ts` | 82.80% |
| `persisted-observation-parser.ts` | 85.32% |

Expand the enforced cohort based on consequence, not a target vanity number.
At minimum, persisted observations/parser, coordinator observations, graph
scheduler, transition-derived/stops/plan, executable boundary/validation/
compatibility, and scheduling belong in the risk surface. Keep reviewed
unreachable/defensive branches fingerprinted and test feasible behavior.

### Missing model and performance assurance

The suite has excellent hand-authored scenarios and mutation canaries, but no
property/state-machine generator. For a deterministic engine, generate bounded
DAGs and legal observation sequences and assert:

- recomputation returns byte-identical plans;
- event sequences are contiguous and monotonic;
- an invocation is admitted once per logical attempt;
- terminal states never resurrect;
- ready/admitted sets agree with invocation state;
- loop budgets and ordinals are conserved;
- branch scopes never cross;
- persisted replay is idempotent or rejected on conflict; and
- cancellation/deadline never invents provider certainty.

Shrinking is especially valuable because failures produce a minimal graph and
event sequence rather than another large fixed fixture. Add maximum-contract
benchmarks for nested structure, 1,000 nodes, checkpoint member/byte edges,
10,000 database facts, branch fan-out, and loop cancellation. CI thresholds
should be generous and stable; detailed performance baselines can run nightly.

### CI truth

GitHub CI builds and typechecks the package, runs all unit tests in the core
matrix, executes the selected coverage gate and risk report, builds the
production image, and exercises engine behavior indirectly in service-backed
database/worker jobs. The local pre-push hook runs static/unit/coverage gates;
`prepush:full` additionally runs service integration.

This is good automation. It does not currently protect the omitted full-source
coverage, fact-capacity compatibility, nested scheduler complexity, or
generative invariants. “CI passed” therefore means the declared gates passed,
not that every engine branch or maximum contract was tested.

## Plan and ADR compliance

The implementation strongly follows the blueprint:

- it is a pure deterministic scheduler/interpreter in a modular monolith;
- the API admits work, the worker executes, and the database commits plans;
- graph publication pins immutable definition, executor, ABI, policy, and
  side-effect behavior;
- checkpoints are versioned, bounded, reconstructable, and compatibility-
  checked;
- retries are bounded/deterministic and never retry unsafe possible dispatch;
- durable waits release worker slots;
- cancellation/deadline stop new work while running effects reconcile;
- branch, join, Parallel/Merge, and For Each scopes are explicit;
- node attempts resolve only exact inputs and verified executable identity;
- replay/redelivery does not duplicate logical attempts or events; and
- no speculative queue-per-node, provider framework, or microservice exists.

The package is not contradicted by the plan. The plan was correct to require
versioned deterministic behavior and explicit side-effect semantics. The
remaining gaps are implementation/control details:

- database/engine fact capacities are not one contract;
- full transition/compatibility risk coverage is narrower than the engine's
  actual consequence surface;
- no model-based invariant suite explores combinations beyond fixtures; and
- repeated projection/scanning/stringification adds avoidable runtime work.

## Findings

### WFE-001 — Database-admissible fact backlogs exceed the engine boundary

- **Severity:** P1
- **Classification:** confirmed defect
- **Evidence:** database loading permits 10,000 facts and up to 4,096 canonical
  bytes per fact. `parsePersistedObservations` normalizes the whole array with
  `NODE_JSON_LIMITS_V1` (1,048,576 bytes and 10,000 total members). A 6,000-fact
  valid-shaped progress probe serialized to 1,186,897 bytes and failed as
  `observation_invalid`; its approximately 42,000 fields also exceed the member
  cap. About 1,500 seven-field facts already cross 10,000 members.
- **Impact:** a legitimate long-running/noisy run can load as ready from
  PostgreSQL but fail every engine advancement, stranding coordination until
  manual intervention or retention.
- **Remediation:** define one cross-package fact-window contract. Prefer bounded
  incremental parsing/indexing or database pagination with a cursor-safe commit
  protocol. Never silently truncate facts needed for contiguous event truth.
- **Verification:** real database/worker integration at exact limit and one
  over for count, aggregate bytes, and members; prove forward progress across
  pages and exact cursor/event sequencing.
- **Status:** open.

### WFE-002 — Nested scheduler projection recomputes each body twice per ancestor

- **Severity:** P2
- **Classification:** confirmed performance/maintainability defect
- **Evidence:** `schedulerState.projectGraph` calls `projectGraph(body)` once in
  a spread and again to read `structuredBodies`; each child repeats the pattern.
  Work/allocation grows exponentially with nested depth. A valid depth-14 probe
  took roughly 5–9 ms after warm-up; shallower depth-6 was under 1 ms. Current
  executable JSON depth rejects depth 15 in that fixture.
- **Impact:** present bounds contain but do not justify superlinear work. Future
  structure/JSON-limit changes can turn a hidden inefficiency into worker CPU/
  memory amplification.
- **Remediation:** compute each child projection once and flatten structured
  descriptors in one traversal, or build a prepared executable index at verify
  time.
- **Verification:** invocation-count instrumentation proves every graph visited
  once; depth/width benchmarks scale linearly.
- **Status:** open.

### WFE-003 — Coordinator advancement repeatedly scans and normalizes the same data

- **Severity:** P2
- **Classification:** maintainability and performance improvement
- **Evidence:** branch and For Each derivation independently normalize the same
  persisted/completed arrays. Completed items scan all persisted facts and
  checkpoint invocations; executable nodes are flattened within a branch item
  loop; Merge derivation filters projected invocations for each branch;
  operation failure/provider-key paths repeatedly flatten/find nodes.
- **Impact:** large allowed event, invocation, and branch sets create quadratic
  work and obscure which layer owns validation/indexing.
- **Remediation:** parse facts once, build maps by sequence/attempt/invocation,
  prepare executable node/edge/scope indexes once, and pass a read-only context
  to derivation stages.
- **Verification:** characterization tests remain byte-identical; maximum-size
  benchmarks demonstrate bounded near-linear scaling.
- **Status:** open.

### WFE-004 — The coverage score excludes central engine decisions

- **Severity:** P2
- **Classification:** continuous assurance gap
- **Evidence:** CI's 91.02% branch threshold covers 13 selected files. All-source
  branch coverage is 84.75%. Persisted facts, coordinator derivation, scheduler,
  transition derivation/stops, executable validation/compatibility, and other
  material files are absent.
- **Impact:** regressions can lower coverage in core state behavior without
  failing the advertised workflow-engine gate.
- **Remediation:** expand consequence-selected includes and use per-file
  ratchets; keep reviewed exceptions fingerprinted.
- **Verification:** deleting a test from each critical family fails CI or
  creates a new unreviewed risk entry.
- **Status:** fixed as a continuous source-hashed coverage safeguard.
- **Implemented evidence (2026-09-05):** enforced coverage now includes all 26
  consequence-selected engine files: persisted observation admission/parsing,
  coordinator derivation, scheduler projection, transition derivation/stops/
  planning, executable boundary/validation/compatibility, scheduling, and the
  original checkpoint/operation cohort. The original 13-file cohort retains
  its stronger aggregate thresholds, each newly admitted decision owner has a
  file-specific branch floor, and the expanded cohort has a separate aggregate
  ratchet. Fresh coverage is 90.56% statements (1,844/2,036), 85.32% branches
  (1,779/2,085), 93.62% functions (338/361), and 91.74% lines (1,766/1,925).
  Compatibility-history admission gained public boundary tests. Every one of
  the remaining 225 workflow-engine branches now carries an exact source hash
  and branch-specific defensive, unreachable, or generated justification; the
  repository report rejects semantic drift and records zero unreviewed sites.

### WFE-005 — Engine checkpoint admission is weaker than persistence admission

- **Severity:** P2
- **Classification:** confirmed boundary inconsistency
- **Evidence:** `parseCheckpoint` accepts `resumeAt: "0"`, while database schema
  requires ISO datetime. `createCheckpoint` accepts empty/unbounded engine and
  workflow identities, while persistence requires bounded pattern/UUID values.
  Similar length constraints differ across scope and checksum fields.
- **Impact:** a public engine constructor/parser can report success for a value
  the next persistence seam rejects, shifting failures and complicating
  recovery ownership.
- **Remediation:** establish one browser-independent persisted checkpoint
  contract or shared primitives; make engine constructors emit and parser admit
  exactly storage-valid representations while preserving legacy versions
  explicitly.
- **Verification:** a shared exact/one-over corpus runs through engine and
  database parsers with identical acceptance for current schemas.
- **Status:** open.

### WFE-006 — Checkpoint and executable boundaries repeat full hostile-input scans

- **Severity:** P2
- **Classification:** maintainability and performance improvement
- **Evidence:** public checkpoint dispatch scans once, V1 scans again, and V2
  scans then invokes the scanning V1 parser. Executable boundary calls the safe
  scanner then a normalizer that calls it again; execution context is also
  double-scanned.
- **Impact:** hot checkpoint transitions pay two to three complete object/byte
  traversals, and duplicated admission calls make future limit changes easier
  to misapply.
- **Remediation:** separate unknown-boundary admission from trusted normalized
  grammar functions. Keep exactly one hostile-object scan before canonical
  allocation and one final semantic parse.
- **Verification:** instrument scanners at V1/V2/executable exact limits and
  assert one admission traversal while all hostile-object tests remain green.
- **Status:** open.

### WFE-007 — Structured scope equality is duplicated through JSON serialization

- **Severity:** P2
- **Classification:** maintainability improvement
- **Evidence:** iteration paths are compared with `JSON.stringify` in
  operations, graph scheduler, coordinator observations, transition state, and
  stop processing. Branch prefixes are separately hand-compared. Equivalent
  scope identity is therefore distributed across at least six call sites.
- **Impact:** extra allocations occur in nested loops and one semantic change
  can drift between readiness, validation, completion, and cancellation.
- **Remediation:** define a canonical `scopeKey` plus exact/prefix helpers over
  `BranchScopePart`/`IterationScopePart`, and include the key in prepared
  indexes. Do not export it as a repository-generic utility.
- **Verification:** property tests for equality, inequality, prefix, delimiter,
  Unicode, and nested ordinals; all transition fixtures stay byte-identical.
- **Status:** open.

### WFE-008 — Deterministic state-machine invariants lack generative testing

- **Severity:** P2
- **Classification:** continuous assurance gap
- **Evidence:** 226 strong examples and two mutation canaries exist, but no
  property/model-based generator explores bounded DAGs, event sequences,
  branch/loop scopes, duplicates, cancellation, and retry combinations.
- **Impact:** combinatorial ordering/replay defects can remain outside carefully
  authored fixtures, especially as new structured controls arrive.
- **Remediation:** add a small model and shrinkable legal/invalid generators;
  assert determinism, conservation, monotonicity, idempotency, and terminal
  invariants listed above.
- **Verification:** seeded reproducibility in PR CI and a larger scheduled seed
  budget; mutation canaries demonstrate the properties detect policy changes.
- **Status:** open.

### WFE-009 — Duplicate declaration equality omits scope and topology

- **Severity:** P3
- **Classification:** defensive correctness improvement
- **Evidence:** `sameLoopDeclaration` compares collection and limits but not
  control key, branch/iteration scope, body roots, or sink.
  `sameJoinDeclaration` compares policy and branch IDs but not join/scope
  identity. Existing state is retained, so a conflict is ignored rather than
  applied.
- **Impact:** an internally inconsistent coordinator replay may be accepted as
  idempotent instead of failing closed, weakening debugging and future adapter
  safety.
- **Remediation:** compare every declaration field that defines durable meaning
  using canonical scope/output helpers.
- **Verification:** public behavior tests mutate one field at a time and require
  typed conflict errors with unchanged state.
- **Status:** open.

### WFE-010 — The production export surface includes unused shallow primitives

- **Severity:** P3
- **Classification:** maintainability improvement
- **Evidence:** join/loop scheduling functions, retry resolution/decision,
  durable wait/cancellation decisions, transition assertions, and several
  status internals have no production external consumer; applications use
  primary operations, executable support, checkpoint functions, types, error,
  and `invocationKey`.
- **Impact:** internal refactors appear breaking, partial-runtime-validation
  helpers look like supported boundaries, and the Interface is harder to learn.
- **Remediation:** inventory intended consumers, retain only supported root
  capabilities, and expose low-level state-machine primitives from `./testing`
  or package-internal files where appropriate.
- **Verification:** package export contract plus repository import scan; API and
  worker build without deep/internal imports.
- **Status:** open.

### WFE-011 — Small duplicated primitives reduce ownership clarity

- **Severity:** P3
- **Classification:** maintainability improvement
- **Evidence:** node flattening exists as both `allExecutableNodes` and
  `executableNodes`; ordinal comparison is defined in foundation and ordering;
  UUID/timestamp/output equality and terminal-status sets recur across parser/
  transition files.
- **Impact:** changes can drift and each helper's owner is less obvious, though
  current behavior is mostly aligned.
- **Remediation:** consolidate only identical domain primitives inside the
  engine. Preserve separate helpers where error code or trust boundary differs.
- **Verification:** deletion test: one implementation remains for each exact
  semantic rule and no generic “utils” dumping ground is introduced.
- **Status:** open.

### WFE-012 — Phase 3 public compatibility has no removal milestone

- **Severity:** P3
- **Classification:** compatibility retainer
- **Evidence:** `PHASE3_RUNTIME_POLICIES_V1` is deprecated, unused internally
  and externally, and recorded in the compatibility ledger. Durable
  `phase3-engine-v1` serialized identity remains a separate required value.
- **Impact:** indefinite source aliases expand API and preserve historical
  naming after migration value disappears.
- **Remediation:** keep it through the documented compatibility window, then
  remove it in an explicitly breaking release. Do not rename durable stored
  engine identifiers in place.
- **Verification:** downstream/source usage scan, release note, and retained
  checkpoint/executable compatibility suite.
- **Status:** intentionally retained; removal milestone open.

## What should remain unchanged

- Keep the engine deterministic and infrastructure-free.
- Keep executable verification, checksum, compatibility, and process-authenticity
  defenses.
- Keep checkpoint V1/V2 grammars explicit and fail closed.
- Keep transition ordering visible rather than hiding it in a generic state-
  machine library.
- Keep provider side-effect class and `outcome_unknown` semantics explicit.
- Keep stable deterministic retry jitter and provider keys.
- Keep durable waits and database compare-and-swap outside worker memory.
- Keep controlled mutable transition state private to one operation.
- Keep public behavior tests for complex branches; do not return to direct
  mutation of private state.
- Keep parser complexity where it represents one atomic persisted grammar.
- Keep immutable/frozen executable identity until profiling and mutation
  evidence justifies change.

## Recommended implementation order

1. Fix WFE-001 jointly with the database/worker observation-window contract and
   add exact-limit real-service tests.
2. Add WFE-004 coverage for persisted facts and transition derivation before
   refactoring their internals.
3. Introduce one prepared executable/fact/scope context to address WFE-002,
   WFE-003, and WFE-007 with byte-identical characterization tests.
4. Align checkpoint boundaries for WFE-005 and remove redundant scans for
   WFE-006 without weakening hostile-input defenses.
5. Add WFE-008 model-based invariants and maximum-contract performance tests.
6. Tighten duplicate declaration comparison for WFE-009.
7. Reduce public/duplicate surface under WFE-010 and WFE-011.
8. Retire WFE-012 only at its documented breaking compatibility milestone.

Completion means current-schema engine/database acceptance is aligned, maximum
fact windows advance, consequence-selected coverage is enforced, generated
state sequences preserve invariants, and performance work is measured. The
existing 226 passing tests are strong evidence, but not sufficient evidence for
those open contracts.

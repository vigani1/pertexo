# ADR 010: Node and executor compatibility and retirement

- **Status:** accepted
- **Date:** 2026-08-20

## Context

Published workflows and durable runs can outlive the deployment that accepted
them. A registry that resolves the latest node at execution time or removes an
old executor as soon as placement is deprecated would make recovery depend on
rollout timing and could silently change validation, mappings, retry behavior,
or effects. The Phase 2 published graph pins definition and config versions but
does not durably identify an executor or every runtime policy needed to execute
it. The browser also needs node metadata without receiving server executor code.

## Decision

### Stable identities and registry layers

A node definition is identified by the immutable pair
`{ definitionKey, definitionVersion }`; an executor is identified separately by
the immutable pair `{ executorKey, executorVersion }`. A runtime policy is
identified by `{ policyKey, policyVersion }`. Keys are stable, lowercase,
dot-separated platform namespaces and versions are positive integers that are
never reused. Changing a schema, port, config meaning, retry class, resource
class, evaluator behavior, executor ABI, or other compatibility-relevant
behavior requires a new appropriate version rather than changing an existing
identity in place.

Phase 3 reserves these first definition and executor identities:

- definition `core.manual@1`, executor `core.manual@1`;
- definition `core.set@1`, executor `core.set@1`; and
- definition `core.terminate@1`, executor `core.terminate@1`.

`core.set` is the Set/Map product node and pins the restricted JSONata policy
from ADR 009. Matching definition and executor keys are convenient for the first
release, but their identities remain separate contracts. A later definition may
reuse a compatible executor, and an executor may explicitly support more than
one definition.

The registry has three layers:

1. The **manifest** is browser-safe product metadata: definition identity,
   family, versioned config/input/output schemas, ports, credential
   requirements, retry and resource classes, capabilities, definition lifecycle
   state, and its exact executor reference.
2. The **executor** is a server-only implementation indexed by executor
   identity. It declares the definition, config, executor ABI, and runtime policy
   versions it accepts and is never included in browser artifacts.
3. The **instance** is user configuration in a draft or immutable authoring
   graph. It references a definition identity and config version; it neither
   contains executable code nor selects an executor dynamically.

### A distinct published-executable envelope

The complete definition-only authoring graph remains in
`workflow_versions.graph_json` so a retained version can be displayed and
diagnosed. Phase 3 adds a separate immutable, versioned executable envelope on
the same `workflow_versions` row. The additive columns are
`executable_schema_version`, `executable_json`, and
`compatibility_release_epoch`; the existing versioned `checksum` column remains
the workflow content identity.

Executable envelope schema V2 contains:

- its literal schema version and the source authoring-graph schema version;
- the canonical execution-relevant graph, including stable IDs, topology,
  mappings, configs, config versions, and execution settings;
- for every node, its exact definition and executor identities;
- exact versioned references for the executor ABI, value-source/JSONata,
  retry, timeout, cancellation, and scheduler/checkpoint policies that apply;
  and
- a compatibility-selection fingerprint over those referenced definitions,
  executors, migrations, and policies, plus the durable release epoch and full
  release fingerprint under which the envelope was first admitted.

The V2 checksum is SHA-256 over a domain-separated, canonically serialized V2
execution projection and uses `wf:v2:sha256:<hex digest>`. The projection
includes the compatibility-selection fingerprint but excludes only the full
release epoch/fingerprint, which is admission provenance rather than execution
behavior. Consequently executor, runtime-policy, or selected-compatibility
differences cannot reuse a V1 or another V2 version by graph appearance alone,
while an unrelated catalog addition does not manufacture a new workflow
version. Publication reparses the locked authoring graph, resolves every exact
reference through the locked compatibility release, builds the V2 envelope,
recomputes the V2 checksum in the publication transaction, and stores the graph,
envelope, release epoch, and checksum atomically. Reuse under a later compatible
release preserves the original immutable envelope and records the later release
in the publication audit fact. Workers parse the stored envelope and select only
its exact executor and policies; they never reconstruct those references from
the current catalog or substitute a latest version.

The schema migration is additive. Existing V1 rows retain their original
definition-only `graph_json`, schema version, and `wf:v1:sha256` checksum with
null executable-envelope columns. API and maintenance releases continue to
parse and verify every retained V1 graph and checksum for history, diagnosis,
and explicit migration. A V1 row is not executable and cannot accept a new run,
replay, or trigger delivery because it lacks exact executor and runtime-policy
references. Republishing its graph under an active compatibility release
creates or resolves a distinct immutable V2 version; it never updates the V1
row. CI retains golden V1 and V2 parsing, canonicalization, and checksum fixtures
and rejects a release that can no longer verify either retained format.

### Definition and executor lifecycle

Placement, publication, admission, and execution are separate decisions:

- **Placeable** means the editor may add a new instance of a definition.
- **Publishable** means an existing instance and its complete graph may produce
  a new V2 envelope under the current compatibility release.
- **Admissible** means a published V2 version may accept a new run, replay, or
  trigger delivery.
- **Executable** means an already admitted run may select the exact executor and
  policies pinned by its V2 envelope.

A definition advances through these catalog states:

| Definition state | New placement | New V2 publication |
| --- | --- | --- |
| `active` | allowed | allowed when full validation passes |
| `deprecated` | blocked | allowed for existing instances during the migration window |
| `migration_required` | blocked | blocked until an explicit draft migration and republish |
| `retired` | blocked | blocked |

An executor advances through these release states:

| Executor state | New V2 reference | New run/replay/trigger admission | Existing admitted run |
| --- | --- | --- | --- |
| `staged` | blocked | blocked | not selected |
| `active` | allowed through an active definition | allowed | executable |
| `retained` | blocked | allowed for an already published V2 version | executable |
| `retirement_blocked` | blocked | blocked | executable until dependencies drain |
| `retired` | blocked | blocked | no executable dependency may remain |

Normal transitions are `staged -> active -> retained -> retirement_blocked ->
retired`. A failed retirement remains `retirement_blocked`; reopening admission
requires a separately audited later release that explicitly returns it to
`retained`. States never mutate inside an immutable release record.

Each compatibility release has a deterministic fingerprint over a versioned,
canonically ordered projection of every definition identity and lifecycle
state, compatibility-relevant manifest field, executor identity and lifecycle
state, exact definition/executor compatibility edge, config migration, and
runtime-policy reference. Any lifecycle transition therefore creates a new
release epoch and fingerprint. Authoring representations include the active
fingerprint as required by ADR 011.

An unknown definition remains readable as opaque draft data but is neither
placeable nor publishable. Deprecation never makes an already admitted run
unexecutable. Publishability is computed from the complete vertical slice, not
asserted by a manifest boolean; a node remains absent from the publishable
registry until all required domain, authorization, adapter, telemetry,
durability, contract, and verification gates pass.

### Configuration migration and retained compatibility

Config migrations are versioned, deterministic, side-effect-free functions
between adjacent config versions. They accept and return JSON-compatible data,
do not read clocks, randomness, network, credentials, or mutable application
state, and have exact input/output fixtures. Skipping a step or falling forward
to a newer schema is forbidden.

An authoring migration creates a changed draft that the user validates and
republishes. It never rewrites an immutable V1 or V2 workflow version. An
already admitted V2 run executes the original envelope. If an executor needs a
normalized runtime form, that exact pure normalization policy is pinned in the
envelope and never persisted back into the authoring graph or published row.

CI retains at least one immutable workflow fixture for every supported
definition/executor/policy combination. Each fixture parses its original graph
and executable envelope, verifies its stored checksum, selects only its pinned
executor and policies, and produces the expected canonical result. Contract
tests also prove unique identities, exact declared compatibility, lifecycle
transition validity, and the absence of executor modules from browser exports.

### Durable compatibility releases and race-safe retirement

Compatibility state is PostgreSQL-authoritative. An append-only audited
`node_compatibility_releases` record stores the epoch, fingerprint, canonical
catalog, lifecycle states, predecessor epoch, actor/reason, and creation time. A
singleton `node_compatibility_current` row points to the active epoch and
fingerprint. Only an audited maintenance operation may prepare or activate a
release; serving roles can read the release records but cannot mutate them.

Each API and worker artifact supplies the set of expected epoch/fingerprint
pairs it supports during a rolling overlap. Normal readiness reads the durable
current pair and fails unless it is in that expected set, the artifact's role-
specific catalog projection matches the durable catalog, and the process can
parse every graph, envelope, checksum, config, evaluator, job, and event version
declared by that release. A separate preactivation readiness probe names one
prepared target pair from the expected set and performs the same validation
against its durable release record without treating it as current. The API
projection contains browser-safe manifests, executor references, and policy
metadata but no executor implementation; every publishable definition must
resolve to a worker capability declared by the release. The worker projection
additionally contains every implementation marked executable. A process does
not become ready by trusting an environment fingerprint without matching it to
the durable record. Release activation is authorized only after the deployment
controller records successful preactivation readiness for the required API and
worker roles against the target pair.

Publication, run acceptance, replay acceptance, and trigger admission read and
lock `node_compatibility_current` inside the same transaction that creates the
new durable reference. They validate the current epoch/fingerprint, envelope
schema/checksum, definition state, and executor state before commit, and reject
the command if the current pair is outside that process's expected set. Queue
consumers perform the same current-pair check, reload the V2 envelope by ID, and
validate its pinned selection and exact executor. Jobs remain identifier-only.
Accepting current and previous queue/event schemas during rollout never
authorizes executor substitution.

Retirement uses this serialization barrier:

1. An additive release containing both old and new executors is deployed and
   passes API/worker readiness before any new definition is made publishable.
2. To retire an identity, maintenance atomically activates a new epoch that
   moves it to `retirement_blocked`. Activation takes the exclusive lock on
   `node_compatibility_current`; admission transactions holding the corresponding
   lock finish first, and every later publication, run, replay, and trigger
   admission is blocked for that identity.
3. After the blocking epoch commits, an audited maintenance query checks the
   exact executor identity across active published workflow pointers,
   nonterminal runs, replay-eligible retained runs, admitted attempts,
   checkpoints, and unpublished outbox work. Existing admitted runs may finish
   through the still-retained executor.
4. Retirement records the dependency-query epoch and result. Final activation
   of `retired` uses a compare-and-swap requiring the same current blocking
   epoch/fingerprint and revalidates that no dependency exists. A stale result,
   changed epoch, or concurrent reference aborts retirement rather than removing
   code.
5. Only after that durable result may a subtractive worker release omit the
   executor. Releases containing the old executor remain deployable throughout
   the blocking and drain window, and rollback restores one of those retained
   artifacts rather than rewriting workflow versions.

The dependency query runs through the audited maintenance role, never a serving
role or privileged request connection. Cache state, queue emptiness, deployment
age, and lack of recent traffic are not retirement evidence. API and worker
readiness fail on release-record/fingerprint disagreement or a current catalog
whose required executable identity is absent.

### Phase 3 boundary

This ADR releases compatibility policy only for Manual, Set/Map, and Terminate
in the small Phase 3 graph. Phase 3 implements the initial active durable
compatibility release, V2 envelope pinning, publication/run-admission locking,
role-specific readiness, retained fixtures, and fail-closed exact executor
selection. It enforces a non-removal invariant: no Phase 3 executor may enter
`retirement_blocked` or `retired`, and no subtractive release may omit it.

The maintenance command that begins retirement, cross-feature dependency query,
replay/trigger admission barriers owned by later slices, CAS retirement
finalization, and subtractive fleet rollout evidence are deferred until the
first real executor retirement after the relevant admission paths and Phase 7
operator controls exist. The policy and serialization protocol above remain
binding on that future implementation; Phase 3 does not scaffold or falsely
claim to exercise paths that do not yet exist.

This ADR does not make Condition, Switch, For Each, Parallel, Merge, Wait,
provider integrations, generic HTTP, webhook/schedule triggers, credential
resolution, node preview, remote plugins, dynamic code loading, or additional
worker resource classes publishable. Those capabilities require their planned
later vertical slices and prerequisite ADRs.

## Consequences

The stored V2 envelope makes executor and runtime-policy selection reproducible
and auditable for the pure Phase 3 nodes, and unsupported retained state fails
closed instead of silently falling forward. It does not promise byte-identical
external-provider behavior, preserve an executor after its audited replay and
retention obligations end, or make deployment environment differences
irrelevant. The cost is additive workflow-version storage, V1/V2 compatibility,
durable release coordination, retained executor artifacts and fixtures, and a
serialized retirement process. Retirement becomes an explicit product and
operational lifecycle rather than ordinary dead-code deletion.

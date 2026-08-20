# ADR 002: PostgreSQL JSONB drafts, immutable versions, and checksum identity

- **Status:** accepted
- **Date:** 2026-08-20

## Context

The workflow editor and execution engine need different persistence semantics.
An editor changes one coherent graph repeatedly and must detect stale saves. A
run must execute one stable graph even while the workflow is edited or
published again. Splitting the canvas into rows for arbitrary node fields would
make a single edit and publish operation span many independently mutable
records, while storing only one mutable document would let an edit change what
an active run means.

The authoritative plan therefore distinguishes a stable `workflow` identity,
one mutable `draft`, and immutable published `workflow versions`. PostgreSQL is
the authority for all three. The graph contract is versioned separately from
the HTTP API and is a coherent JSON value, making JSONB an appropriate storage
boundary, but tenant ownership, lifecycle, revisions, version numbers,
checksums, actors, and timestamps still require modeled columns and database
constraints.

Publication also crosses an external-side-effect boundary. Database state can
atomically select a published version and record a durable request for trigger
reconciliation, but creating, replacing, or disabling provider webhooks and
schedules cannot participate in the PostgreSQL transaction. That work must
begin from a durable post-commit signal without making Redis or BullMQ
authoritative. Phase 2 establishes only that boundary; trigger persistence and
external reconciliation arrive with the trigger slices in Phases 4 and 6.

This decision fixes the workflow persistence and publication boundary. ADR 011
owns the draft-save HTTP concurrency contract and the future collaboration
boundary; this ADR defines the database revision that contract protects. ADR
003 owns workspace RLS and runtime roles, and ADR 005 owns transactional outbox
delivery and consumer idempotency.

## Decision

### Store a stable workflow, one mutable draft, and immutable versions

Use three distinct tenant-owned PostgreSQL relations:

- `workflows` stores stable identity and metadata, including `workspace_id`,
  lifecycle and activation status, and the current `published_version_id`.
- `workflow_drafts` stores exactly one mutable graph snapshot per workflow,
  including `workspace_id`, `revision`, `schema_version`, `graph_json`, update
  actor, and update timestamp.
- `workflow_versions` stores published snapshots, including `id`,
  `workspace_id`, `workflow_id`, `version_number`, `schema_version`,
  `graph_json`, `checksum`, publish actor, and publish timestamp.

All three carry direct, non-null workspace scope even where it could be reached
through a join. Composite foreign keys and unique keys prove that a draft,
published version, and published pointer belong to the same workspace and
workflow. `workflow_drafts.workflow_id` is its primary key, with a
same-workspace foreign key to `workflows` and explicit `ON DELETE CASCADE`.
That proves at most one draft per workflow and removes the draft only with its
workflow. Version numbers are unique and monotonically assigned within a
workflow; they are display/order metadata, not content identity.

The application creates a workflow and its empty, structurally valid revision-1
draft in one transaction. There is no standalone draft-create or draft-delete
repository capability and serving roles receive no draft `DELETE` grant.
Therefore every live workflow created through a serving path has exactly one
live draft: the primary key enforces at most one, while atomic creation and the
absence of an independent delete path enforce at least one. Deleting a workflow
through the later retention policy deletes its mutable draft by the declared
foreign-key action. Readiness and integration tests prove these grants and
paths; owner/maintenance operations remain separately audited.

A published version is retained as operational history and is never edited in
place. Every run references exactly one version ID, so changing a draft or
publishing a later version cannot change an existing run's graph.

### JSONB is the atomic graph boundary

`graph_json` stores the complete graph contract as JSONB. It contains the
versioned nodes, stable node and edge IDs, pinned node-definition versions,
configuration versions, explicit mappings and connection references, graph
settings, and authoring metadata required to reopen the snapshot. It does not
contain raw credentials, files, execution state, or unbounded payloads.

The workflow-model package owns the graph schema and canonicalization rules.
Both draft and version reads parse the stored value at the persistence seam.
Draft writes parse and enforce structural and size limits before persistence;
publish additionally performs deterministic semantic validation, executor
compatibility checks, config migrations, cycle and bounded-loop validation,
expression-policy validation, and a secret scan. Unknown schema or definition
versions remain readable for diagnosis and migration but are not publishable
or executable through an unpinned fallback.

Relational projections may later support queries that JSONB is poor at.
`workflow_integration_usage` and desired trigger records are derived indexes,
not competing graph authorities, and must remain reconstructable from a
published version. They are deliberately absent from the Phase 2 migration:
integration usage arrives with the first integration slice in Phase 4, and
trigger persistence/reconciliation arrives with the trigger slice in Phase 6.

### Draft revisions protect the mutable snapshot

Every draft begins with a defined initial revision and each successful save
increments it exactly once. The write is a compare-and-swap update scoped by
workspace and workflow:

```sql
UPDATE workflow_drafts
SET graph_json = $graph,
    schema_version = $schema_version,
    revision = revision + 1,
    updated_by = $actor_id,
    updated_at = transaction_timestamp()
WHERE workspace_id = $workspace_id
  AND workflow_id = $workflow_id
  AND revision = $expected_revision;
```

Changing zero rows is not retried as an overwrite. The application distinguishes
an invisible or missing workflow from a visible revision conflict and returns
the conflict contract defined by ADR 011. The database revision, not an ETag
parsed in a repository or an in-memory editor counter, is authoritative.

### Canonical content defines version identity

Before inserting a version, the application derives a versioned executable
projection from the complete validated graph snapshot and serializes that
projection with the platform's one versioned canonical JSON algorithm.
Canonicalization is recursive and deterministic: object keys are sorted, node
and edge collections are sorted by stable IDs because their array order has no
execution meaning, arrays whose order is defined by a node contract retain that
order, JSON scalar representations are normalized by the algorithm, and values
not representable by the graph schema are rejected. Database JSONB text output,
JavaScript property insertion order, and locale-sensitive formatting are never
used as checksum inputs.

The SHA-256 checksum input is a domain-separated, versioned envelope containing:

- the canonical executable graph projection;
- the graph schema version;
- every pinned node-definition and node-config version; and
- all execution-relevant workflow settings.

The stored graph remains the complete published snapshot, including its
contractually stored authoring metadata. The executable projection excludes
only fields explicitly classified as presentation-only by the graph contract:
node `position`, node `label`, and non-semantic node/edge collection order.
Stable node and edge IDs, topology, definitions, configs, mappings, connection
references, and config/policy versions remain included. The `disabled` value
and disabled node contents also remain included deliberately: disabled topology
affects validation, scheduling, later restore, and whether enabling that node
is a new executable publication. Workflow settings use an explicit contract
allowlist: execution limits and policies are included, while a presentation
setting can be excluded only after it is typed as presentation-only and covered
by identity tests. Unknown settings fail publication instead of being silently
excluded.

V1 does not attempt graph isomorphism or behavioral equivalence beyond those
explicit presentation exclusions. Two publications are identical only when
their versioned canonical executable projections are byte-identical. Thus a
label or position-only edit may reuse the prior executable version; the draft
retains its newer presentation metadata, while the reused version remains the
original immutable snapshot. A future change to the projection or field
classification requires a new checksum-algorithm version and compatibility
tests; it cannot silently reinterpret retained checksums.

`workflow_versions` enforces uniqueness on `(workflow_id, checksum)` as well as
`(workflow_id, version_number)`. A checksum is content identity within one
workflow, not globally and not across tenants. The `checksum` value uses a
versioned domain format such as `wf:v1:sha256:<hex digest>` so verification does
not depend on whichever canonicalizer is current when the row is later read.

### Publishing is idempotent and reuses identical executable content

`POST .../publish` requires both an `Idempotency-Key` and exactly one strong
`If-Match` value obtained from the draft representation defined by ADR 011.
There is no redundant expected-revision body field. The server resolves the
opaque validator to the expected draft revision; weak, wildcard, list, or
malformed validators follow ADR 011's precondition errors.

The application stores only the idempotency-key digest. The durable request
hash is a canonical, domain-separated envelope over the operation, actor,
workspace, workflow, the original quoted `If-Match` value, and any other
publish input. Idempotency is scoped to that actor, workspace, workflow, and
operation. Reusing a key with a different request hash is
`request.idempotency_conflict` and cannot publish.

After authorization and idempotency key/request-hash validation, an exact retry
of a completed command returns its durable original result before comparing the
validator with current draft state. This remains an exact replay even if the
draft has since advanced. It returns the resolved version ID/number and reused
flag and performs no new draft read, version insert, pointer update, audit
append, or outbox insert. A concurrent exact retry waits on or observes the one
claimed idempotency record and returns the same committed result; it cannot
execute the command twice. A failed transaction does not leave a completed
result.

A distinct key is a distinct publish command. Its `If-Match` must still select
the current draft: a well-formed stale validator returns `412 Precondition
Failed` with `workflow.revision_conflict` and the safe current validator details
defined by ADR 011. It may reuse the same content version only when its current
draft has the same executable projection, and then it appends its own publish
audit fact and outbox event.

Publishing is one application transaction:

1. Authorize the actor, require the idempotency key and strong `If-Match`,
   compute and validate the request hash, and return an already completed exact
   replay before comparing current draft state.
2. Resolve the opaque validator, read the selected draft, and perform
   deterministic validation and config migration outside the main transaction
   where possible, retaining the exact graph and revision read.
3. Enter the workspace-scoped transaction; claim or re-resolve the idempotency
   record under its unique scope. A concurrent exact command waits and returns
   the committed result, while a mismatched hash fails before workflow state is
   changed.
4. Lock the `workflows` row followed by its `workflow_drafts` row with
   `SELECT ... FOR UPDATE`. Verify that the locked draft revision matches both
   the `If-Match` resolution and the validated revision. Holding the draft row
   lock prevents a save from changing that snapshot until publication commits
   or rolls back.
5. Reparse the locked graph and recompute its executable projection and
   canonical checksum. Reject any mismatch rather than publishing the earlier
   unlocked read.
6. Resolve the existing `(workflow_id, checksum)` version, or allocate the next
   workflow-local version number and insert a new immutable version. Concurrent
   insertion conflicts are resolved by re-reading the unique checksum row, not
   by cloning identical content.
7. Point the workflow at that version but keep `activation_status = inactive`.
   Phase 2 publishing never enables production triggers or admits production
   runs.
8. Append the safe audit fact and exactly one versioned `workflow.published`
   outbox row whose strict dispatch kind is `reconcile-workflow-triggers`.
9. Store the original successful response in the idempotency record in the same
   transaction, commit, and return the resolved version, including whether it
   was newly created or reused.

Publishing an unchanged canonical executable projection returns the existing
version ID and version number. It does not create another row merely to advance
a release number. A distinct command's audit fact records the new publish
attempt, and its outbox event is safe to redeliver. An exact idempotent replay
creates neither. Release labels may later reference an existing version but
must not duplicate its executable content.

The transaction rolls back the pointer, version, audit fact, outbox event, and
completed idempotency result together on any database error. No reader can
observe a pointer to an uncommitted or partially built version.

### Phase 2 stops at the trigger reconciliation outbox boundary

Publication records the `workflow.published` domain event in PostgreSQL with
the strict `reconcile-workflow-triggers` dispatch kind. It performs no provider
API call, BullMQ enqueue, desired-trigger-table write, webhook registration,
schedule activation, or Redis write inside the publication transaction. The
outbox payload is a versioned, identifier-only contract containing the outbox
event, workspace, workflow, and resolved workflow-version IDs plus trace
context; it contains no graph or credentials.

Phase 2 proves only that a successful non-replayed publish commits exactly one
strict outbox row with its version pointer and that rollback or exact command
replay commits none. It does not dispatch that event to an external trigger
provider, create integration-usage or desired-trigger tables, claim trigger
health, or prove provider reconciliation. The transactional dispatcher and
inbox behavior remain governed by ADR 005. Phase 4 adds integration usage with
the first side-effecting integration, and Phase 6 adds trigger persistence and
an idempotent reconciler that converges external resources after commit.

The outbox dispatcher claims only kinds present in a validated deployment
capability allowlist. Its PostgreSQL claim query filters by that allowlist; it
must not claim an unsupported kind and then reject it in process. Every Phase 2
API and worker deployment excludes `reconcile-workflow-triggers` because no
consumer exists. Consequently these rows remain durable in PostgreSQL with
`published_at` and lease owner/expiry null and attempt count zero. They never
enter Redis, do not consume retry attempts, and cannot become exhausted or
dead-letter work merely because the future consumer is absent. Readiness fails
if a deployment enables a kind without its compatible consumer capability.

Phase 6 rolls this boundary forward in order: deploy and prove the compatible
versioned consumer and trigger persistence, make that consumer ready, then add
`reconcile-workflow-triggers` to the dispatcher allowlist. The normal ADR 005
claim/replay path can then publish the retained Phase 2 rows. Rollback removes
the capability again without losing those still-unpublished PostgreSQL rows.

Until that reconciler exists, published workflows remain inactive. This keeps
Phase 2 honest while preserving the durable boundary required for later
post-commit convergence.

### Enforce tenant isolation and immutability in PostgreSQL

The migration owner owns all workflow tables. API and worker runtime roles are
non-owners without `BYPASSRLS`; tenant tables enable and force RLS using the
transaction-local workspace context from ADR 003. Policies cover both row
visibility and write checks, and repository operations still include explicit
workspace predicates.

Runtime grants are least privilege:

- the API role may select and perform the application-owned workflow, draft,
  publication, audit, idempotency, and outbox operations needed by commands;
- the worker role receives neither workflow-version `SELECT` nor any workflow-
  authoring mutation grant in Phase 2; Phase 3 adds the minimum version-read
  grant with the first executable run slice; and
- neither serving role may alter schema, policies, constraints, ownership, or
  RLS, and neither may update or delete a published version.

Database constraints and an owner-installed immutability trigger reject every
`UPDATE` or `DELETE` of `workflow_versions`, including attempts through a
mistaken future grant. Retention or legally required erasure therefore uses a
separate audited maintenance design rather than ordinary serving SQL. The
trigger is defense in depth; runtime roles still receive no update/delete
grant. Foreign-key delete actions are explicit and normally `RESTRICT` once a
version is referenced by a published pointer, trigger, or run.

## Migration and readiness consequences

The reviewed Phase 2 workflow-persistence migration creates only `workflows`,
`workflow_drafts`, and `workflow_versions`, then uses the existing audit,
idempotency, and outbox infrastructure. It does not create integration-usage or
trigger tables. The migration must create the modeled columns, inactive
activation default/check, foreign keys, workspace indexes, checksum/version
uniqueness, forced RLS policies, runtime grants, and immutable-version trigger
together. It must also establish the exact current migration head expected by
the API and worker. Production startup never pushes or synchronizes this
schema.

The migration must make partial invalid states unrepresentable where
PostgreSQL can do so: positive draft revisions and version numbers, supported
checksum prefixes and fixed digest length, valid JSON object shape at the
coarse database boundary, same-workspace composite references, at most one
draft per workflow, and published pointers that reference a version of that
same workflow. Atomic creation, the same-workspace draft foreign key, cascade
behavior, and absence of a serving draft-delete capability complete the
exactly-one-live-draft invariant. Full graph validity remains in the versioned
workflow-model parser; SQL does not duplicate the complete graph schema.

API readiness fails closed when the migration head is wrong or when
introspection finds an incompatible workflow schema. Compatibility checks cover required
column types/nullability, foreign keys and delete behavior, uniqueness and
indexes, the draft primary/foreign key and cascade action, the
immutable-version trigger, enabled and forced RLS, policy expressions,
ownership, runtime role attributes, exact grants including no serving draft
delete and no worker version read, and the inactive activation constraint.
Readiness also verifies that the API supports every checksum algorithm and
graph schema version it may publish or return. It must not fall back to a
privileged connection or silently treat an unknown version as current. Worker
workflow-version readiness and execution compatibility begin in Phase 3.

An existing deployment may introduce these tables because Phase 2 has no
production workflow data. Later checksum or graph-schema changes require an
additive migration and rolling compatibility plan: retained rows keep their
recorded algorithm/schema versions, old versions are not rewritten, and new
publication is enabled only when all serving roles understand the new contract.

## Verification obligations

Unit and contract tests must prove:

- graph parsing, bounds, canonical serialization, and SHA-256 output are
  deterministic across key insertion order, processes, and supported runtimes;
- one-unit-over graph limits and non-JSON, credential-bearing, unknown-schema,
  or unknown-definition input is rejected at the correct seam;
- golden identity fixtures prove that position, label, and non-semantic
  node/edge collection-order changes preserve identity, while topology, stable
  IDs, definitions, configs, mappings, connection references, `disabled`, and
  each execution-relevant setting change identity;
- disabled-node and settings fixtures prove their deliberate inclusion rules,
  and unknown settings fail rather than disappearing from identity;
- the same executable projection produces the same checksum and every retained
  checksum version remains verifiable; and
- API, workflow-model, database, generated documentation, and future web client
  use the same versioned request/response and graph contracts, including the
  mandatory publish idempotency key and strong `If-Match`.

Real PostgreSQL integration tests using the migration and serving roles must
prove:

- workflow creation and its revision-1 empty draft commit atomically, a serving
  role cannot create/delete a draft independently, and workflow deletion takes
  the draft through the declared cascade without leaving an orphan;
- exact-revision saves increment once, stale and racing saves never overwrite,
  and rollback preserves the previous snapshot and revision;
- workspace A cannot observe or mutate workspace B's workflow, draft, version,
  audit, idempotency, or outbox rows, and absent workspace context fails closed;
- a save-versus-publish race proves the draft row lock: publish-lock-first
  freezes and publishes the validated revision before the save proceeds, while
  save-first makes publish return the safe `412 workflow.revision_conflict`; no
  outcome validates one graph and stores another;
- publish creates a complete immutable version, inactive pointer, audit fact,
  durable idempotency result, and one strict `reconcile-workflow-triggers`
  outbox row in one transaction;
- an injected failure at each publication step rolls the entire transaction
  back;
- exact sequential and concurrent idempotency retries return the original
  result without another version, audit fact, pointer mutation, or outbox row;
  replay after a later draft save still returns that result, key/hash mismatch
  is rejected, and a distinct stale key/validator receives the safe `412`
  conflict while a current distinct command may reuse the content version and
  create its own audit and outbox facts;
- repeated and concurrent publication of identical executable projections,
  including presentation-only changes, returns one version row, while changed
  executable content receives a new version number;
- direct version update/delete is rejected for serving roles;
- the API can read a retained supported version but refuses to publish an
  unsupported schema/checksum version;
- Phase 2 creates no integration-usage/trigger tables, performs no provider or
  queue call during publish, and emits no outbox row on rollback or exact replay;
  and
- with the real dispatcher and worker processes running, the capability
  allowlist leaves `reconcile-workflow-triggers` rows unpublished, unleased,
  unattempted, and absent from Redis, while readiness rejects enabling that kind
  without a ready compatible consumer.

The Phase 2 checkpoint records the commands, PostgreSQL version, migration
head, contract and integration assertion counts, representative executable
checksum and golden fixtures, save/publish race and rollback injection points,
idempotency replay proof, RLS/runtime-role proof, and independent review result.
In-memory repositories, mocks, or prose alone do not satisfy this ADR.

## Consequences

Positive consequences:

- Editors can replace one coherent draft while stale writers receive an
  explicit conflict instead of silently merging or overwriting.
- Every future run and trigger can be traced to one stable, executable snapshot.
- Identical executable publication reuses content without creating meaningless
  version rows, while command idempotency prevents duplicate effects.
- JSONB matches the graph aggregate while relational columns, constraints, RLS,
  and grants keep authorization and operational queries explicit.
- External trigger work cannot escape from a rolled-back publication; the
  strict outbox boundary is ready for later reconciliation without pretending
  Phase 2 implements it.

Costs and obligations:

- Whole-graph saves can conflict and require the client behavior defined by ADR
  011; V1 does not merge concurrent canvas operations.
- Canonicalization and checksum-algorithm compatibility become durable product
  contracts that require golden fixtures and rolling-upgrade discipline.
- Presentation-only edits may reuse a version whose stored presentation
  snapshot is older; the mutable draft remains the current authoring view.
- Published executable corrections require a new version; operators cannot
  patch a retained snapshot in place.
- JSONB queries may later need deliberate derived projections, but those tables
  and their reconciliation tests stay with the slices that need them.
- RLS, immutability triggers, runtime grants, publication races, and outbox
  boundaries require real PostgreSQL integration tests.

## Rejected alternatives

### Normalize every node, edge, and configuration field into rows

Rejected as the primary model. It turns a coherent canvas edit and publication
into a multi-row consistency protocol and couples persistence to arbitrary UI
field shape. Purpose-built projections remain allowed for proven query needs.

### Execute the mutable draft or copy it into each run

Rejected. Draft edits could change active behavior, and per-run graph copies
would duplicate content without providing a stable publish/audit identity.
Runs reference one immutable version.

### Create a new version number for every publish click

Rejected. A monotonically larger label is not a reason to clone identical
content. The checksum identifies existing content, while audit history records
the distinct publish command.

### Hash PostgreSQL JSON text or ordinary `JSON.stringify` output

Rejected. Those encodings are not the platform's stable cross-process content
contract and can vary with key order or implementation details. The checksum
uses one versioned canonical JSON algorithm before persistence.

### Register external triggers inside the publication transaction

Rejected. Provider APIs and queues cannot join the PostgreSQL transaction and
would reopen both dual-write failure windows. Publication commits desired state
and an outbox event; an idempotent reconciler performs external side effects
after commit.

### Rely only on application code for version immutability and tenancy

Rejected. A missed predicate or accidental repository method must not expose a
tenant or rewrite execution history. Forced RLS, least-privilege grants,
constraints, and an immutability trigger enforce the boundary in PostgreSQL.

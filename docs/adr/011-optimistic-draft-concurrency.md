# ADR 011: Optimistic draft concurrency and future collaboration boundary

- **Status:** accepted
- **Date:** 2026-08-20

## Context

A workflow has one mutable, whole-graph draft. Editors autosave, requests can
be retried after an uncertain network result, and two tabs or actors can edit
the same workflow concurrently. Last-write-wins would silently discard a
newer graph. Holding a database lock for an editing session, storing every
canvas gesture as a row, or introducing a multiplayer merge protocol would
add state and failure modes that V1 does not need.

The API must expose the database revision as an HTTP precondition without
making clients depend on an ETag's internal format. It must also keep request
idempotency distinct from concurrency control: an idempotency key can replay a
command result, but it must never authorize a write based on stale state.

## Decision

V1 saves the complete workflow graph with optimistic concurrency. Exactly one
`workflow_drafts` row exists per workflow. Its positive `revision` starts at
one when the workflow and empty draft are created and increases by exactly one
for every successful save. A read returns the graph and numeric revision and
sets a strong `ETag` for that selected draft representation.

ETags are opaque to clients. The server owns their generation and comparison;
clients persist and echo the complete quoted value. The V1 tag codec computes
SHA-256 over a domain-separated canonical envelope containing the workflow ID,
draft revision, schema version, canonical graph, and the deterministic
definition-compatibility fingerprint used to produce the returned report,
then emits `"draft-v1.<base64url-sha256>"`. The codec is shared by draft reads,
saves, and publication. Clients must not construct a tag from the numeric
revision or depend on that encoding. Tags use strong comparison because
`If-Match` uses the strong comparison function defined by RFC 9110.

The compatibility fingerprint is part of the selected representation and
therefore part of strong validator identity. A node-registry rollout changes
the tag and requires the editor to refetch even when the persisted revision is
unchanged. Mixed-version replicas may consequently reject an older tag during
that rollout; this conservative conflict is accepted instead of claiming that
different compatibility reports are strongly equivalent. Phase 2 has an empty
definition catalog with one deterministic fingerprint, so all Phase 2 replicas
produce the same tag. A later registry release must version its deterministic
fingerprint and include rolling-replica conflict behavior in its compatibility
plan.

### Save contract and transaction

`PUT /v1/workspaces/:workspaceId/workflows/:workflowId/draft` accepts the
complete graph and requires exactly one `If-Match` value obtained from the
latest draft read or successful save. `If-Match: *`, a list of tags, weak
validators, malformed tags, and a revision supplied only in the request body
are rejected; V1 has one unambiguous header contract.

The save use case:

1. authenticates the actor and authorizes workflow editing in the path
   workspace without disclosing a cross-workspace workflow;
2. parses the graph and enforces structural and resource limits;
3. loads the authorized current draft, recomputes its tag with the shared
   codec, and strongly compares that value with the supplied tag;
4. captures that row's revision as `expectedRevision` only when the tags match;
5. in one workspace-scoped transaction, updates the row with
   `WHERE workflow_id = ? AND revision = ?`, writes the graph and actor, and
   increments the revision once; and
6. appends the successful save audit fact in that transaction and returns the
   saved graph/revision with the new strong `ETag`.

The initial tag comparison is an early rejection, not the concurrency
authority. The conditional update still decides the race. If it changes no
row, the use case reloads the authorized current row and computes its current
tag for the conflict response; it never retries the update. Malformed or
over-limit graphs are not persisted. Full publish validation is separate, so
a structurally valid draft may contain publish-blocking issues.

### Publish precondition and idempotent replay

`POST /v1/workspaces/:workspaceId/workflows/:workflowId/publish` requires the
same strong `If-Match` tag as draft saving and also requires
`Idempotency-Key`. Publication may only validate and publish the exact draft
representation the actor reviewed. Missing, weak, wildcard, list, malformed,
and stale validators have the same `428`, `400`, and `412` behavior defined
for saves.

The publish use case orders deduplication and concurrency checks deliberately:

1. authorize the actor and hash the canonical publish request, including the
   workspace, workflow, original `If-Match`, and any publish options;
2. look up the actor-/workspace-/workflow-/operation-scoped idempotency key;
3. return the recorded response for an exact completed key and request-hash
   match, even if the draft has changed since that original publication;
4. reject reuse of the key with another request hash as
   `request.idempotency_conflict`;
5. for a new command, claim the idempotency record and strongly compare the
   original `If-Match` with the current draft representation before performing
   publish validation or mutation; and
6. inside the publish transaction, recheck the captured draft revision before
   creating or reusing the immutable version and completing the idempotency
   result.

Only an exact replay may return the original success after the draft moves. A
new key with a stale publish tag, or a race that changes the revision before
commit, returns canonical `workflow.revision_conflict` `412` and never
publishes the newer draft implicitly. Request idempotency preserves the result
of one command; `If-Match` proves which draft representation that command was
allowed to publish. Neither replaces the other.

### Failure responses

An absent precondition returns `428 Precondition Required` with
`application/problem+json` and the dedicated public/application code
`request.precondition_required`. A malformed or unsupported validator returns
`400 Bad Request` with `request.invalid`.

If the tag is well formed but is not current, or the conditional update
changes no row because another save won the race, the transaction makes no
draft or audit mutation. The API returns `412 Precondition Failed` with code
`workflow.revision_conflict`. This follows RFC 9110 conditional-request
semantics rather than using `409 Conflict` for a failed `If-Match` condition.
This decision requires the shared application/public error catalog to add
`request.precondition_required` with canonical status `428` and to change the
canonical status of `workflow.revision_conflict` from `409` to `412` before
the draft endpoint is implemented. No controller-local status override is
permitted.

The common `ApiProblem` output remains strict and unchanged. The contracts
package exports an extendable raw shape (or equivalent schema factory) and
constructs each finalized schema independently; code never calls `.extend()`
on a strict/readonly finalized schema. The required shape is equivalent to:

```ts
export const ApiProblemShape = {
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: ApiProblemCodeSchema,
  requestId: z.string(),
  errors: z.array(ApiProblemIssueSchema).optional(),
} satisfies z.ZodRawShape

export const ApiProblemSchema = z.object(ApiProblemShape).strict().readonly()

export const WorkflowRevisionConflictProblemSchema = z
  .object({
    ...ApiProblemShape,
    status: z.literal(412),
    code: z.literal("workflow.revision_conflict"),
    currentRevision: z.number().int().positive(),
    currentEtag: StrongEtagSchema,
  })
  .strict()
  .readonly()
```

The response repeats `currentEtag` in the `ETag` header. The specialized
problem factory accepts only a typed revision-conflict application error and
copies its safe typed details; unrelated problems cannot acquire arbitrary
extension members. These values are produced only after the actor is
authorized for that workflow. A missing or invisible workflow still uses the
normal non-disclosing `resource.not_found` response.

The client must treat `currentEtag` as opaque and use a fresh `GET` to obtain
the authoritative graph. The conflict payload is a synchronization hint, not
a merge base and not permission to resend the old graph against the new tag.

### Autosave and retries

An editor has at most one save in flight per draft. It debounces local changes
and sends the latest coherent graph with the ETag of its loaded base. If more
local edits happen while a save is in flight, the next save uses the ETag
returned by the successful response. A `412` stops autosave for that draft,
preserves the unsaved local graph, loads the current server graph, and asks the
user to reload or explicitly reconcile. V1 does not silently overwrite,
automatically merge, or repeatedly retry a revision conflict.

Transport retry is bounded. Repeating the same `PUT` and stale `If-Match`
after the first request committed cannot mutate state again; it receives the
current conflict response. When a response may have been lost, the client
reads the current draft and may recognize that its canonical graph is already
present, but it does not perform another write without a current precondition.

Phase 2 draft saves neither accept nor persist `Idempotency-Key`. The mandatory
precondition and stale replay behavior are the complete V1 duplicate-mutation
contract for this endpoint. Optional result replay is outside the Phase 2
completion criteria and requires a later decision; it may not weaken or
replace `If-Match`.

### Future collaboration boundary

Whole-graph compare-and-swap is the V1 collaboration model. Client-side undo,
local command history, presence, patches used only as transport compression,
and explicit user-assisted reconciliation may be added without changing the
authoritative PostgreSQL snapshot.

Real-time multiplayer editing, automatic three-way merge, operational
transformation, CRDT state, durable per-gesture commands, and long-lived edit
leases are deferred. Promoting any of them requires a new ADR that defines
participant identity, ordering and causality, offline convergence, tombstone
and retention policy, authorization changes during a session, publish
coordination, migration from snapshot revisions, and operational limits. Such
a protocol may materialize a snapshot for publication, but it cannot silently
reinterpret existing revision or ETag semantics.

### Authorization, audit, and telemetry

Authentication, workspace membership, workflow edit permission, tenant
transaction context, and RLS are all required; possession of an ETag is not
authorization. Successful saves append an audit event with actor, workspace,
workflow, old and new revision, request/trace IDs, and bounded safe metadata.
The audit row never stores the graph, node configuration, expressions, secret
references, or raw ETag. Authorization denials use the platform's security
audit path. Expected revision conflicts are measured and logged but do not
append a draft-mutation audit fact.

Successful publication appends the publication audit fact and completes its
idempotency result in the publication transaction defined by ADR 002. An exact
idempotency replay returns that result without another version, pointer update,
outbox event, or audit fact. A stale new publish command produces no
publication audit mutation.

The save span records the route template, operation, outcome, and revision
transition. Structured logs may carry workflow/workspace IDs under existing
access and redaction policy, but never the graph or raw configuration.
Metrics cover save latency and outcomes such as `success`, `invalid`, and
`revision_conflict`; workflow, workspace, actor, revision, and ETag values are
prohibited metric labels.

## API, schema, and test consequences

- `workflow_drafts.revision` is non-null, positive, and updated only by the
  guarded save transaction. The same transaction sets `updated_by` and
  `updated_at` and appends the safe audit fact.
- Shared Zod/OpenAPI contracts describe the graph request, the draft response,
  required `If-Match`, success `ETag`, dedicated
  `request.precondition_required` `428`, and the separately strict
  `WorkflowRevisionConflictProblem` `412`. The shared catalog maps
  `workflow.revision_conflict` to `412`, the common `ApiProblem` remains
  strict, and generated artifacts must pass the existing drift check.
- Draft and publish application results carry a typed `representationTag`
  beside their bodies, and a typed revision-conflict error carries only
  `currentRevision` and `currentEtag` safe details. The HTTP response
  mapper/global problem filter below the controller owns the `ETag` header.
  Controllers pass `If-Match` to one use case and never generate tags, set
  conflict statuses, or manually shape problem extensions.
- Repository integration tests use the real API runtime role and prove a
  matching update, an atomic two-writer race with one winner, cross-workspace
  invisibility, RLS enforcement, monotonic revision, and transaction rollback
  of both draft and audit state.
- HTTP tests prove strong-tag round trips, the new tag on success, missing,
  weak, wildcard, list, malformed, and stale preconditions, the safe
  authorized conflict extension, non-disclosing not-found behavior, graph
  validation before persistence, a deterministic empty-catalog fingerprint,
  a changed compatibility fingerprint producing a different tag, and no
  mutation on every failure path.
- Retry tests prove a repeated committed request cannot increment the revision
  twice: its now-stale tag returns `412` without another mutation. Contract
  tests prove the common strict/readonly schema rejects conflict extensions and
  unknown keys; the specialized strict/readonly schema requires literal status
  `412`, literal code `workflow.revision_conflict`, `currentRevision`, and
  `currentEtag`, and rejects missing or extra members. Compile-time assertions
  preserve readonly inferred outputs, while artifact drift tests keep those
  exact schemas, headers, dedicated problem codes, and canonical statuses
  aligned.
- Publish tests prove missing `If-Match` is
  `request.precondition_required` `428`, a new stale key is
  `workflow.revision_conflict` `412`, a changed request under the same key is
  `request.idempotency_conflict`, and an exact original key/hash replay returns
  its recorded version after the draft moves without another version, audit
  fact, projection rebuild, pointer mutation, or outbox event.

## Consequences

### Version restoration clarification — 2026-09-06

Restoring a published version is a draft edit, not publication and not restoration
of an archived workflow. `POST
/v1/workspaces/:workspaceId/workflows/:workflowId/versions/:versionId/restore`
requires a strict empty body, the current draft's single strong `If-Match`,
session/CSRF and `workflow:update` authority in an active workspace. The workflow
must also be active; restoring a version never implicitly unarchives it.

A dedicated persistence transaction selects the current compatibility release,
locks workflow authority before the draft, resolves the immutable source version
by workspace/workflow/version together, and compares the current draft's full
representation tag. It parses the retained graph with current draft limits and
applies the existing definition-placeability rule against the current draft.
It then copies the source graph into the draft, advances its revision once and
records `workflow.version_restored` with the source version ID and revision
transition. These facts commit or roll back together. Source version/checksum,
published pointer, activation, lifecycle and existing runs remain unchanged.
No reconciliation event is produced and no executor or provider runs.

The response is the normal draft response and its new strong ETag, with HTTP
200. Like draft save, this operation does not claim an idempotency key: a retry
after a committed response was lost receives 412 for the now-stale tag and must
read the draft. This deliberately reuses the existing editor concurrency model
instead of introducing a second durable replay protocol for one kind of draft
edit. A fresh-tag explicit restoration advances the revision even if the graph
already matches. Unknown/cross-workflow/cross-tenant source versions use the
existing non-disclosing 404 policy; a version ID is not authority.

Required proofs cover source-scope denial, malformed/stale/missing tags,
current-catalog tag changes, blocked definition placement, exact source graph
copy and audit identity, both concurrent save/restore outcomes, archive races,
rollback, no-op graph identity with monotonic revision, retry behavior and
unchanged nonempty publication/run history. The authenticated HTTP proof must
exercise the actual database method, not compose an unverified client-side
version read and save.

Concurrent edits fail visibly and the database decides the winner with one
cheap conditional update. Autosave remains simple, stateless API replicas can
serve any request, and clients receive standards-based conflict behavior.

The trade-off is coarse whole-graph contention: independent edits conflict,
and a user may need to reconcile manually. ETags and revisions must be carried
through every client and generated contract, audit writes share the save
transaction, and uncertain responses require a read before further editing.
These costs are accepted for V1 instead of introducing a collaboration system
before product demand justifies it.

## References

- [RFC 9110, If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)
- [RFC 9110, 412 Precondition Failed](https://www.rfc-editor.org/rfc/rfc9110.html#name-412-precondition-failed)
- [RFC 6585, 428 Precondition Required](https://www.rfc-editor.org/rfc/rfc6585.html#section-3)
- [RFC 9457, Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)

# F08 — Callable-target discovery and explicit exact-version Upgrade

Status: design accepted for source-only implementation after primary full-read
review and independent Spec/Standards closure, 2026-10-04. The final reviewed
proposal SHA256 was `2aadd9274c36f9456e50614dd992252f14d2889d8f3b841120af5fef4dfb875c`.
Acceptance authorizes bounded additive implementation, not availability or native
runtime qualification. No public contract, route or permission is implemented
by this document; no catalog, installation or production activation is authorized.
Native publication/execution remain OFF. The five
open qualification fact groups and excluded security campaign remain unchanged.

## Settled requirements and observed gap

[ADR065](../adr/065-durable-parent-child-workflow-calls.md#decision) selects exact
same-workspace immutable pins, whole bounded acyclic dependency closure and
configuration-only preview. The accepted
[contract proposal](08-subworkflow-contract-proposal.md) specifies, under typed
contracts/pins, that publication verifies child agreement, callable/executable
identity and current editor use; Upgrade explicitly edits the draft, and later
child publication never changes a retained parent pin. Its “Authority, lifecycle
and preview” section requires current publication authority and readable child
pins; runtime child acceptance separately requires initiating authority,
membership revision, lifecycle, compatibility and ordinary admission.
[F08 frontend scope](08-subworkflows.md#frontend-work) requires an exact-version
picker/upgrade notice. This proposal implements those decisions, not new child
authorization, execution, auto-upgrade or cross-workspace semantics.

Existing owners establish the following source facts:

- `WorkflowAuthoringController.versions`, `ListWorkflowVersionsUseCase`, and
  `createWorkflowAuthoringReadStore.listVersions` provide bounded published-source
  history. Their current response contains graph/checksum, not executable envelope,
  contract identity, current compatibility or permission-to-use authority.
- `SessionAuthenticationGuard` authenticates the opaque session;
  `WorkflowReadGuard` requires an active workspace and `workflow:read` with
  not-found disclosure. Persistence independently checks current active
  workspace/user/membership. The workspace-policy owner permits all five roles
  to inspect, but only owner/admin/builder to update and publish workflows.
- `validateNativePublicationClosure` resolves exact workspace/workflow/version,
  Graph2/executable3/checksum and whole callable identity. It does not currently
  check callee workflow activity or verify its stored executable against the
  current compatibility selection. Those are implementation gaps, not authority
  supplied by the proposed response.
- `normalizeWorkflowAuthoringCompatibility.selectLocked` owns the current locked
  artifact-supported release selection. `createCoreAuthoringOptions` chooses the
  V2/V3 builder within that selection; a compiler callback existing is not proof
  the selected release supports native policies/definitions.
- `verifyWorkflowExecutableV3` owns admission provenance, current release
  compatibility, whole executable checksum and native policy validation;
  `workflowCallableContractIdentityV1` owns the complete declaration identity.
  Native `mapVersion` validates source format but does not recompute V3 checksum.
- The existing source browser cannot commit a node change. `WorkflowCallPinEditor`
  owns four-field format-only editing through `NodeFormApi.commit`;
  `WorkflowCallSetup` protects unfinished scratch and unknown JSON configuration.

## Proposed smallest public interface

Add an opt-in projection to the existing authenticated GET
`/v1/workspaces/:workspaceId/workflows/:workflowId/versions`:

`?include=callableTarget&limit=1&after=<cursor>` pages one explicitly selected
workflow (proposed projection limit 1–25, default 1, subject to one aggregate
request budget below). `?include=callableTarget&versionId=<uuid>` performs one exact-version
refresh on the same owner; `versionId` is mutually exclusive with `limit/after`.
There is no “latest”, version-number pin, all-workspace version fanout, new Upgrade
command, or mutation GET. Existing default query/response remain byte-for-byte
contract-compatible; projection queries and schemas are separate strict variants.

### OpenAPI and typed callers

Keep the existing `listWorkflowVersions` GET operation and legacy
`workflowVersionsQuerySchema` / `workflowVersionsResponseSchema` exports intact.
The existing `packages/contracts/src/workflow-authoring.ts` document/artifact
owner must describe the opt-in query grammar and strict 200 response variants
with `oneOf`, explicitly associating legacy versus `include=callableTarget`
requests in the operation description. Projection responses have required
`projection: 'callableTarget'`; the strict legacy schema forbids that field and
the projection-only fields, so the alternatives are disjoint. OpenAPI response
selection cannot itself depend on a query parameter: raw generated operation
callers must narrow/validate the union, not assume their old concrete return type
still applies. Regeneration must expose that change, never erase it with a cast.

Preserve existing typed public wrappers (`getAllWorkflowVersions`,
`findWorkflowVersion` and source queries): they send no include parameter and
decode only the legacy schema, retaining their existing concrete return types.
An additive projection wrapper on that same version-read owner sends the literal
include and decodes only its strict schema; it cannot accept legacy JSON as an
authoritative result. Contract artifacts, HTTP response validation and these
wrapper return types must agree. Regressions must regenerate/check OpenAPI and
client-schema artifacts, exercise both response branches, reject cross-decoding,
and compile an unchanged legacy source-browser call site with its original types.
Do not add a duplicate endpoint, importer, compiler or store to escape typed
compatibility. Raw generated-client union changes must be explicitly documented
and migrated at their call sites; unchanged default JSON alone is insufficient.

Response: `{ projection: 'callableTarget', workspaceId, permissions, items, nextCursor }`, where `permissions`
is `{ canEditDraft, canUseInPublication }` computed from the current transaction's
membership using existing `workflow:update` / `workflow:publish` policy. These
are actor-scoped observations, not transferable capabilities or session tokens.
`nextCursor` is null for exact lookup; list cursors bind projection purpose, actor,
workspace and workflow using the existing cursor owner, without a new key.

Each item contains `id`, `workflowId`, `versionNumber`, `publishedAt`, and:

| Field | Exact meaning and computation owner |
| --- | --- |
| `callableTarget.pin` | All four `WorkflowCallPinV1` fields from one verified immutable stored native executable/source pair; otherwise null. Never an identity assembled by the browser. |
| `callableTarget.contract` | Bounded input/result type descriptors from that verified declaration, otherwise null. No copied graph, result literal, selector code or alternate contract authority. |
| `callableTarget.eligibility` | Discriminated `eligible`, `ineligible` with reason, or `unavailable` with reason. Target-local current publication-use assessment, not validity of any parent graph or admission of a run. |

`eligible` requires non-null pin/contract, active target workflow, verifiable
retained native executable, supported native authoring capability in the locked
current release, and verified current compatibility for the target's bounded
dependency closure. It does not require that this version equals the workflow's
current published pointer. Old supported exact versions remain selectable.
Permission is separate: a viewer may inspect an eligible target while both
permission fields are false. Do not claim `run:start` from publication permission;
runtime initiation/admission has its own existing checks.

Definite `ineligible` reasons: `not_native_executable`, `not_callable`,
`workflow_inactive`, `current_compatibility_denied`, `dependency_ineligible`.
`unavailable` reasons: `native_authoring_unavailable`,
`compatibility_support_unavailable`, `dependency_assessment_unavailable`.
They distinguish a known refusal from missing capability. Native OFF never yields
`eligible`; a verified historical pin may still be inspectable. A pin/contract
must be null when immutable identity itself cannot be verified. No invented
positive eligible example is served while native authoring is unavailable.

Native authoring availability is an explicit server-owned default-OFF state in
the existing runtime/authoring owner, never an optional caller flag or browser
inference. Positive target assessment additionally requires the actual compiled
artifact's native verification/compilation capability, exact supported locked
release and native definition/runtime/callable policies. Missing or contradictory
capability is unavailable, even when a callback exists. OFF always yields
`native_authoring_unavailable`, never `eligible`; the ordinary default GET does
not consult this projection gate or change its behavior. This local state and
scoped eligible/ineligible responses cannot activate native publication, change
public readiness, declare installation compatibility or supply semantic authority.
Public native readiness and all existing publication/runtime gates retain their
own authoritative checks and may refuse despite a scoped assessment.

## Computation, authority and failure semantics

Keep computation private to the existing database authoring/read/publication
module. Add one bounded target assessment shared by discovery and publication;
the HTTP serializer merely validates its projection. Reuse transaction/pool
ownership, source mapping, callable identity, release history and V3 verification
owners. Do not add a parallel catalog, graph compiler, policy evaluator, cached
eligibility authority or SQL owner. A supported admission-release resolver and
current native capability assessment must be wired from the existing runtime
compatibility owner, not guessed from epoch equality, checksum prefixes or
compiler presence. Current and admission releases may differ when supported.
Verify the stored envelope/checksum under its supported immutable admission
release and the locked current release, with `alreadyAdmitted=false`. Also use
the existing V3 builder under that original admission release to check the stored
source's executable identity against the same checksum; validating two declarations
independently does not establish source/envelope agreement. Reuse the existing
runtime's injected verification/compilation dependencies rather than introduce a
database-owned compiler. Memoize exact immutable versions within the request,
never current authority across requests. Disjoint closures share one request
budget; memoization is not a substitute for that budget.

### One finite aggregate request budget

Proposed operational caps are conservative reuse of existing owners, not new
family semantics or a claim that the current worker already implements this
assessment. All selected versions plus all discovered dependency versions count
together; no counter resets per item, phase, cache hit or continuation attempt.

| Named request cap | Existing owner and application |
| --- | --- |
| `uniqueVersions` | `WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns + 1` (65), across the entire page/exact lookup and closure union. This is an operational ceiling, not permission to truncate a closure. |
| `sourceBytes` | `WORKFLOW_GRAPH_CONTRACT_LIMITS.graphBytes` (1 MiB), aggregate serialized graph payload consumed across selected/dependency versions, including repeated payload reads. |
| `executableBytes` | `WORKFLOW_EXECUTABLE_LIMITS_V2.bytes` / `NODE_JSON_LIMITS_V1.bytes` (1 MiB), aggregate serialized executable payload consumed, not one allowance per version. |
| `verificationEnvelopeBytes` | `AUTHORING_VALIDATION_BUDGET.envelopeBytes` (2 MiB) for the complete combined worker payload, including graphs, executables and required release/policy descriptions. Both preceding byte caps also apply. |
| `verificationMembers` | `NODE_JSON_LIMITS_V1.members` (10,000), aggregate admitted JSON members across the combined verification payload; every graph/envelope also retains its ordinary depth/member limits. |
| `verificationNodeVisits` | `WORKFLOW_CALL_FAMILY_POLICY_V1.maxExpandedInvocations` (1,000), aggregate node work admitted to source building and envelope verification, charged for each scheduled verification/build pass, including structured descendants. Existing parsers enforce their own finite work too. |
| `verificationJobs` | One request-owned sequential bounded batch, at most one source build and one envelope/current verification per unique version; no fanout or retry replenishes its counters. |
| `queueMs`, `startupMs`, `workMs`, `joinMs` | Existing `AUTHORING_VALIDATION_BUDGET` queue/startup/parse/termination maxima (500/500/1,000/250 ms), once for the aggregate batch, not per version. Existing global `maxActive`, `maxQueued`, `maxQueuedBytes` caps must also govern admission. |
| `responseBytes` | Existing authoring `reportBytes` (256 KiB), including descriptors and all projection items; not a separate per-item allowance. |

Preflight row sizes before fetching/parsing full stored graph/executable payloads;
reject before a fetch would exceed remaining aggregate bytes. Count closure
expansion as it is discovered; do not load unbounded history or an entire release
catalog history to find a pin. A page of 25 disjoint closures can exceed the
request budget even if each individual closure is legal. Then the whole request
returns the proposed 503 `workflow.callable_targets_unavailable` with bounded
safe reason `assessment_budget_exhausted`, no partial success, eligible prefix
or continuation built from unchecked rows. An explicit smaller page/exact lookup
may be requested; no hidden unlimited splitting/retry. Deadline/queue exhaustion
has the same whole-request unavailable semantics; external cancellation preserves
the operation's cancellation failure and still aborts and joins owned work.

Heavy graph/executable parsing, rebuilding and verification must run off the main
thread under the existing authoring runtime's bounded worker ownership, using the
existing model/engine implementations there. The present structural validator does
not provide this operation: until the closed assessment adapter and shared job
admission seam below are implemented/reviewed, projection assessment is unavailable. Do not invoke a
synchronous compiler loop on the HTTP/database main thread, create a second
unbounded worker pool, or hold an idle database transaction during this batch.
Read a bounded immutable candidate snapshot, release that read transaction,
compute outside SQL, then freshly authenticate and fence/reread below. Database
query/lock timeouts and request cancellation remain required in both finite SQL
phases. No off-thread result itself grants current authority.

### Worker placement and exact seam delta — review before implementation

The existing `WorkflowAuthoringValidator` and
`packages/workflow-model/src/authoring-validation-worker-runtime.ts` are owned by
workflow-model. Workflow-engine depends on workflow-model, not vice versa. Do
not add engine/API/runtime imports to either model-owned structural module, or
put V3 build/verification in that structural worker. Its existing entrypoint,
graph/policy messages, result schema, `validate` interface and behavior remain
unchanged. No reverse package reference or dynamic-import workaround is allowed.

The proposed compiled assessment entrypoint belongs to workflow-engine:
`packages/workflow-engine/src/compilation/callable-target-assessment-worker.ts`,
emitting its matching `.js` file in the existing engine dist. It imports existing
engine builders/verifiers and model public contracts only. Engine owns its strict
versioned input/result schemas and a closed trusted adapter factory resolving that
fixed compiled URL; API's existing workflow runtime composition installs that
adapter. Neither request nor job submission can supply a worker path, function,
module, arbitrary operation, pool size, deadline increase or release authority.
The model must not import the adapter's engine schema/type implementation.

Reuse one bounded job admission/termination owner, not another worker pool. The
current validator hardcodes both `runtimeUrl` and `replySchema`, so reuse requires
an explicit small seam change, not pretending callback injection already suffices:
extract its existing queue/active/queued-byte accounting, deadline, job-ID framing,
abort/exit/join and shutdown mechanics into one server-only model-owned job owner.
The structural validator delegates its existing fixed structural adapter to that
owner. Runtime composition supplies the engine-owned closed assessment adapter
to the same instance; engine owns payload/result decoding, model owns lifecycle
mechanics. Only the two trusted composition-installed slots may submit work; an
unrecognized slot refuses. Adapter registration is construction-only and cannot
be requested or replaced through HTTP, database content, environment worker paths
or job payload. Per-slot codecs can vary only through these trusted composition
adapters, never through caller callbacks. The same process-wide operational caps
govern structural and assessment jobs together, including shutdown and queued
bytes. This changes an internal server-only interface and needs primary review of
its exact types/exports/composition delta before code; no generic arbitrary-worker
executor or second exported structural-validator replacement is proposed.

Engine-owned assessment messages use a fixed protocol version and exact purpose,
one owner-assigned job ID and bounded immutable version/release snapshot. Entries
contain exact workspace/workflow/version IDs, source, stored executable/checksum,
admission provenance and the required selected release descriptions; no credentials,
SQL, URLs, executable functions or mutable authority tokens. Reply progression is
exactly ready → started with matching ID → result/unavailable with matching ID.
Strict result schemas bind every assessed exact pin and declaration descriptor to
the submitted identities, include the aggregate budget counters, and report only
closed typed assessment outcomes. Duplicate/missing/extra version entries, unknown
keys/purpose/version, unexpected ordering, wrong IDs, oversized results, worker
failure or unsafe rejection normalize to unavailable/failure, never eligibility.
The response remains provisional until the shared owner confirms termination and
join; final current permissions/activity/releases still come from SQL reread.
An entrypoint can compute immutable verification facts, not authorize publication.

The implementation receipt must bind the exact source and emitted entrypoint bytes,
engine message/result schema paths, API composition path, trusted adapter identity
and existing runtime Docker dist closure. Source/compiled-entrypoint tests must
prove the production adapter resolves the emitted engine file, fails closed if
missing/stale or wrong protocol, and uses the actual verifier/builder with no
runtime-supplied path. Add package-direction fixtures plus project-reference and
module-import checks: no model→engine/API imports or references, API→engine/model
only public exports, existing engine→model dependency preserved. Existing dist
COPY presence checks alone are not a full production dependency-byte manifest or
qualification proof. Any inability to share this owner safely returns to primary
with the precise seam delta; do not resolve it with a cycle or new pool.

Authenticate on every request; perform fresh workspace authorization and
transactional current workspace/user/membership checks before returning actor
permission fields. Reuse the existing request operation signal. If off-thread
validation is used, preserve the existing bounded parser/database idle-budget
contract and session reauthorization callback before delivering an actionable
assessment; revoked/expired sessions must not produce one. Do not widen the
legacy read route's permissions or silently reuse its source-only result.

Use tenant-scoped exact queries. Collect the complete bounded exact dependency
set, then in the final fresh transaction lock authority and compatibility in the
existing workspace → actor/membership → compatibility → workflow order. Lock the
selected and every dependency workflow in stable identifier order, then reread
all exact version identities/source-envelope bindings, workflow activity and
release identities before returning any actionable assessment. Compare against
the computed immutable snapshot and recheck current native availability and
permissions. A dependency-set/identity/activity/release change refuses the whole
assessment as unavailable (`assessment_changed`); do not expand locks, accept the
earlier lookup snapshot as current, or silently retry with fresh budget. Accepted
publication retains the same collect → stable lock → reread discipline. An exact
refresh verifies all route identities; a returned row from another workflow or
workspace is an operational identity failure, never a usable pin. Assess the
selected workflow only; no discovery of other resources or live service probes.

Missing/invalid session: existing 401 `auth.unauthenticated`. Malformed IDs,
unknown/repeated query fields, conflicting pagination/exact arguments or invalid
purpose cursor: existing 400 `request.invalid`. Invisible workspace, inactive or
removed membership/user, missing/cross-workspace workflow, or missing exact
version: 404 `resource.not_found`, no existence/eligibility payload. A readable
archived target may have history and `workflow_inactive`; this must not disclose
an otherwise invisible workflow. An authenticated inspector lacking edit/publish
permission gets 200 with false permission fields, not fake use authorization.

Set `Cache-Control: private, no-store`. No success ETag or 304 can preserve an old
permission/eligibility decision. Unconfigured projection implementation returns
an explicit proposed 503 `workflow.callable_targets_unavailable` problem, not legacy
source data or an empty eligible list. That additive code requires contract review
before implementation. Operational SQL/transport failures, malformed persisted data,
contradictory schema/envelope/provenance/checksum/declaration identity, unexpected
verification errors and cancellation remain failures through existing error
translation. Never catch arbitrary errors into `ineligible`/`unavailable` or
report a partially assessed page as complete. Compatibility denial is classified
only by a deliberate typed owner outcome; query failures are not denial evidence.

## Exact selection and Upgrade

Use a separate actor/workspace/workflow/projection-scoped Query key; ordinary
version-source caches cannot seed it. Fetch pages on explicit workflow selection,
not for every workflow. An Upgrade notice may identify a different available
version, but never defaults, selects, commits, publishes or runs it.

Before confirmation, refresh the explicitly chosen version ID, require a complete
successful current assessment and both permission fields, and compare its entire
pin with the preview. Failed refresh, stale data, 401/404, missing projection or
unavailable/ineligible target disables confirmation and forgets actionable data;
inspection-only source may remain visibly labeled. Current draft editable state,
selected node identity/format and scratch guard must also still agree.

One explicit confirmation commits only the server-returned four-field pin to
the selected draft Call node as one undoable edit. Preserve input mappings,
connections, graph metadata and other nodes. No overwrite of unknown config or
unfinished scratch; route/node/draft changes invalidate pending confirmation.
Changed input/result descriptors require a visible comparison and ordinary
draft/publication validation, not silent mapping coercion or rewrites. Same-pin
confirmation is a no-op. Cancel makes no edit. Save still uses the existing
draft ETag contract; Upgrade creates no server-side version/run/publication.

## Revalidation at publication and runtime

The discovery response is never accepted as proof. Publish uses the current
authenticated request and publication capability, current authoring authority,
locked supported release, workflow activity and actual locked draft/ETag. Extend
the existing exact-pin closure resolver to re-assess every readable same-workspace
callee and its current callable/executable compatibility, with no parent or child
pin rewrite. Follow the accepted proposal's stable dependency-workflow lock and
draft-reread discipline; do not acquire ad hoc locks after the parent draft.
Then validate the complete proposed parent's acyclic/depth/child/expansion closure
and compile using the selected variant. Discovery does not certify parent-specific
recursion, family budget, mappings or draft validity. Existing idempotent replay
ordering is preserved, not reinterpreted as a new publication.

Runtime fresh child acceptance independently checks initiating principal/revision,
`run:start`, lifecycle, current compatibility, entitlement, regional admission,
FIFO, queue and capacity; historical discovery/publication grants none of these.
Child republish/archive/permission changes do not mutate existing retained parent
pins or accepted child facts. Production OFF and accepted-family handling remain
with their existing owners.

## Proposed public-seam regressions and delivery bounds

- HTTP/contracts: legacy response unchanged; opt-in strict schemas, exact lookup,
  bounded pages/cursors, no graph payload or latest default; all role permissions;
  missing/expired/revoked session, removed/suspended/rejoined membership, inactive
  workspace/user, cross-workspace/workflow/version, archived visible target;
  unsupported projection and native OFF never become eligible; no-store response.
  Extend `packages/contracts/test/workflow-authoring-contract.test.ts` and the
  existing authoring HTTP test owner to check the strict response union, projection
  discriminator, query mutual exclusion and unchanged default operation/wrapper.
  Existing source-query/public-version wrappers must typecheck without casts.
- Database authoring interface: verified Graph2/executable3 agreement and full
  identity; callable absent; envelope/source mismatch, malformed/checksum/provenance
  data remain errors; supported historical release/current successor versus known
  incompatibility; missing native policy/compiler support; dependency assessments
  bounded and all-or-fail; SQL failure/cancellation never normal refusal.
  Exercise the actual authoring interface with external transaction/query and
  bounded worker adapters, reusing real V3 builders/verifiers as in
  `apps/api/test/workflow-authoring/admission-adapter.test.ts`. Include disjoint
  individually legal closures exceeding aggregate unique versions, source and
  executable bytes, member/node work, whole-batch deadlines and response bytes;
  exact-budget acceptance, shared-version memoization without authority caching,
  no replenishment on reread, cancelled/failed worker joined before return,
  no SQL transaction held during CPU work, and final stable-lock/reread change
  refusal. Real source/envelope verification and native default-OFF tests belong
  to the runtime compatibility owner, not fabricated reader responses.
- Publication interface: permission/activity/release/dependency change between
  discovery and publish; all exact four pin fields rechecked; stable lock ordering
  and reread; recursive/over-budget proposed parent denied; native OFF preserved;
  republished child does not replace a retained pin; exact replay unchanged.
- Editor/browser: inspect-only cannot confirm; stale/failed/denied refresh cannot
  upgrade; explicit different version edits only intended pin and preserves
  mappings; cancel/no-op/undo; scratch and unknown JSON preservation; late response
  after route/node/draft switch ignored; no automatic upgrade/publish/run.
  Extend the existing call-pin/editor/version-source tests for preservation and
  separate projection decoding/cache behavior; controlled HTTP/browser fixtures
  must be labeled non-runtime. The existing publication-owner external-adapter
  cancellation tests are separately verified, not proof of the proposed reader.

Primary design review is complete; the exact scheduler interface/export/composition
sketch still requires review before its implementation. First source-only
implementation can exercise these interfaces with injected external adapters and
real existing verification owners, clearly labeled as non-PostgreSQL/non-runtime
proof. Live browser/backend and native persistence/qualification remain separate
required gates, never closed by such tests. No installer, canonical runtime or
excluded-campaign execution is proposed.

The transport opt-in/exact-refresh grammar, public projection/unavailable problem
shape and shared private assessment placement are implementation choices for
review. A new child-use capability, broader permissions, cross-workspace targets,
automatic upgrading or altered release/runtime authority would be genuinely new
architectural decisions and require a separate ADR before implementation; none is
proposed here. No new ADR is needed merely to implement the settled exact-pin
discovery/explicit draft-edit behavior after review.

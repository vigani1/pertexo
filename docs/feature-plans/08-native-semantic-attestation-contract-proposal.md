# F08 native semantic attestation — accepted concrete contract

Status: **ACCEPTED — 2026-10-03**, paired with [ADR066](../adr/066-native-workflow-semantic-attestations.md).
Prepared against e13ba9ed and full unregistered SQL80b339ad. Direction and ADR
allocation are authorized. Primary accepted exact a6f555d0 after full original
read, seal-refinement read and two independent reviews. Bounded implementation
and owned-local qualification are authorized; permanent provisioning/grants,
registration, activation and deployment remain unapproved.
The current draft remains OFF and all earlier F08 qualification gates remain open.

## Two closed interfaces, inside existing owners

These are proposed private functions, not public exports, endpoints or a general
capability framework. Their implementation may share private framing code, never
a caller-accessible generic signing operation.

| Owner interface | Caller inputs | Verification performed before signing |
| --- | --- | --- |
| Native publication in `workflow-publication.ts` | Same tenant transaction, existing command identity, workflow ID, expected draft revision/ETag, candidate version ID | Locked current actor/membership/workspace and compatibility; stable-order workflow/draft locks; reread full Graph2; existing native compiler/closure verifier against actual immutable callee versions/metadata/pins; declaration, family policy, counts and complete transitive closure |
| Callable result in `coordinator-call-result-authentication.ts` | Same tenant transaction, actual run/version, pending delivery, expected revision, proposed next transition | Actual accepted native executable/declaration and family; unique actual successful sources; protected original bytes/refs/artifact content identity; existing hydration/path/JSONata/type owners; exact proposed value/source match; intended next checkpoint/CAS and terminal status |

Neither interface accepts arbitrary bytes to sign, a verified boolean, an
arbitrary root/actor, caller-selected key or a previously signed historical
token. Publication uses its injected existing compiler authority; result uses
the worker-owned restricted evaluator. Each signs only its purpose after those
checks. No signer callback is exposed to executors, provider integrations,
request handlers, generic database clients or logs.

Concrete private signatures for implementation review (not shipped code):

```ts
attestNativePublication(input: Readonly<{
  client: PoolClient; // the existing tenant/authoring command transaction
  workspaceId: string;
  actorId: string;
  workflowId: string;
  commandKeyDigest: string;
  expectedDraftRevision: number;
  expectedRepresentationTag: string;
  candidateVersionId: string;
  signal: AbortSignal;
}>): Promise<Readonly<{
  graph: WorkflowCallableGraphV2;
  compiled: VerifiedNativeCompilation;
  closure: WorkflowCallClosureV1;
  proof: NativePublicationProofV1;
}>>;

attestNativeCallableResult(input: Readonly<{
  client: PoolClient; // the existing tenant/coordinator outer transaction
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
  expectedRevision: number;
  delivery: CanonicalCoordinatorDelivery;
  plan: ParsedNativeTransitionPlan;
  signal: AbortSignal;
}>): Promise<NativeCallableResultProofV1>;
```

These names describe existing-owner data, not a new public type package.
Compiler/evaluator and purpose key access are configured privately at owner
composition, not accepted per invocation. Each proof has its fixed purpose,
protocol1, challenge ID, key ID and exactly 32 MAC bytes; no caller-selected
algorithm. Verified compilation is returned from actual compilation, never
accepted as input. Native callable result writes also bind their exact succeeded
or definite-invalid outcome/code and verified source facts; authentication failure
must not be converted to that invalid outcome. Ordinary non-callable/nonnative
completion does not acquire this capability.

## Minimal challenge and proof facts

Use protected purpose-specific challenge/consume paths within those two owners.
A challenge may reveal only nonsecret installation identity, purpose/protocol,
active key ID, fresh nonce, backend identity, outer xid and expiry. Database owner
mints it in the current transaction after actual tenant/work identity checks;
it is not a client nonce or a self-asserted GUC. It adds no ancestor/run lock and
does not delegate admission. Existing ordered locks remain authoritative.
Protocol1 challenges expire at SQL clock issuance plus 30 seconds, never extend,
and are checked again at consume and the required final seal's SQL-clock
authorization linearization. This is not a physical-COMMIT expiry guarantee:
serving SQL can use SET CONSTRAINTS IMMEDIATE to fire a deferred seal early and
hold the outer transaction past expiry. All authenticated native writes must be
complete at that seal; immutable truth plus a protected transaction denial marker
prevent later alteration, reconsume or reopening. A self-asserted serving GUC
cannot supply that marker. An early valid sealed transaction may commit later
only with the same closed facts. Changing the authorization bound
requires a new protocol/policy, not an ambient timeout override. Supported native
proof transactions use READ COMMITTED; a different isolation level fails before
challenge issuance/consume instead of trusting a stale key snapshot.

The installation/key facts are private privileged configuration, not another
history/quota/admission owner. Transient challenge/proof records are tenant-bound,
backend/xid-bound and inaccessible for serving direct mutation. Reuse native
transaction-local proof patterns. Successful consume must seal/delete the record
with the existing committed command or CAS/receipt; a deferred fence prevents an
unconsumed/unsealed proof from committing. No token survives to become authority
in an outbox, checkpoint, workflow version, artifact, recovery row or log.

## Exact signed material

Protocol1 has two fixed ordered field lists and purpose-separated keys/domains.
Frame each field as an explicit absence/presence tag, then unsigned big-endian
byte length and exact UTF8 bytes; lists have a bounded count and the same framed
items. Empty and absent are different. Bounds are checked before allocation or
hashing. Reuse existing graph/executable/ledger and 1MiB native value bounds.
Do not serialize JSONB or build a second JSON canonicalizer for signatures.

Common fields: installation ID; purpose and protocol1; active key ID; server
nonce; server/backend/outer-xid identity; SQL-issued expiry; workspace ID;
actual pending command/delivery identity and payload checksum. Typed UUID and
integer fields use one explicitly defined ASCII spelling; no locale formatting,
implicit casts, null concatenation or delimiter-only joining.

Publication fields: actor/current membership revision; own workflow/candidate
version ID; current draft revision and full representation ETag; locked
compatibility epoch/fingerprint; full source Graph2 and native Executable3 exact
bounded bytes; resulting wf:v3 checksum; callable identity or explicit absence;
family policy and own/expanded invocation, child-count/depth bounds; complete
direct sites and transitive exact pin closure, including each actual immutable
version/checksum/contract identity and verified metadata. Signed material must
not drop editor/source data by substituting the structural compatibility graph.

Result fields: run/root/family/accepted workflow-version identities and native
checksum; actual immutable callable declaration/selector identity; expected
current revision and intended next revision/checkpoint bytes/terminal transition;
exact result reference and serialized result bytes/hash/length; actual ordered
selected invocation/node identities, immutable output refs, original byte
checksums/lengths and artifact content identities; actual run-input identity and
checksum/length when used; each nested Call result's protected provenance.
Unreferenced data cannot stand in for a selected source. The same existing
source inspector determines static/all expression dependencies.

Exact bytes may enter the frame directly or through their fixed algorithm
SHA256 plus length only when SQL independently recomputes both from those actual
bytes and binds their normalized projection to the row/proof being written.
Never trust a supplied digest, rehash JSONB for historical byte identity, or let
the token authenticate one byte string while persisting a different projection.
Artifact ID alone is insufficient: bind verified content checksum, byte length,
availability and same-workspace execution ownership. Artifact bytes remain with
their existing reservation/upload/hydration owner.

## SQL consume and raw-writer fences

Protected native publication consumes the signed proof for one actual version
and its metadata/sites/dependencies in the existing publication command
transaction. Existing pointer, integration/trigger projections, audit/outbox
and idempotency owners still commit atomically. SQL checks actual locked draft,
actor/membership/cohort, exact pin closure/family bounds and version identity.
Raw native version/metadata insertion without that one proof fails the native
writer/commit fence, including an old serving writer. No broader table grant.

Protected result persistence consumes the result-purpose proof alongside its
existing accepted-run/version/family, pending canonical outbox, exact source
provenance, actual CAS/receipt, terminal result, wakeup and deferred seal checks.
Unknown-outcome/control/admission and quota fences are unchanged. Literal results
keep their independent SQL equality check as well; attestation is not a bypass.

Both functions have fixed owner/search path, schema-qualified crypto, strict
null/length/format checks, PUBLIC/other-role revocation and only their narrow
intended serving EXECUTE. Neither returns expected MAC, key bytes, an arbitrary
digest oracle or detailed authentication material. All failures are safely
redacted and operational outer rollback, not authoritative child refusal.
An abandoned prelock pass discards its challenge/proof and recomputes on retry.

HMAC-SHA256 uses Node's existing crypto and approved pgcrypto bytea HMAC, not a
handwritten HMAC implementation. The supplied signature must be exactly 32 bytes.
Direct variable-prefix bytea comparison must not expose the expected MAC prefix.
Propose comparing fixed SHA256 digests of domain-separated expected/supplied
MACs instead of their raw prefixes; this does not claim pgcrypto is constant-time
or generally side-channel-resistant. Cryptographic review and differential
vectors must qualify the exact verifier strategy before implementation acceptance;
do not silently narrow the ordinary-login forgery threat model.

## Privileged lifecycle, rotation and readiness

Owner-managed installation identity and independent random 256-bit purpose keys
are provisioned through existing privileged deployment/secret handling, not a
serving RPC. Verification key holders can sign and are explicitly trusted.
API receives publication signer access only; worker receives result signer only.
Do not reuse application encryption/key-ring, provider, cursor, webhook or
absence-token secrets. Keys/tokens/frames/value bytes must not appear in argv,
query/error logs, audit metadata, traces, telemetry or evidence packets. Reject
configuration safely without dumping invalid input. TLS/local connection and
privileged database access assumptions are explicit.

There is one active key ID per purpose/installation, plus at most one prepared
replacement and one bounded retiring key for already-started transactions.
Challenge creation pins the permitted key ID for its bounded outer transaction;
rotation may serialize solely on those key facts, never lock workspace/run/
workflow/ancestor rows. Consume rejects unknown/revoked IDs or expired challenge;
new transactions use the active ID. Retiring keys cannot authorize new challenges
and disappear after bounded transaction drain. No indefinite previous-key ring.
Rotation never accepts a caller's old key selection: only an actual still-valid
server challenge issued under that key before activation can overlap. SQL key
fact locking serializes consume with revocation; key lifecycle operations never
take workspace/workflow/run locks. The authorization validity bound is checked
at the required final SQL-clock seal, which may fire before physical COMMIT;
it is not a client-configurable timeout. Key-fact locks last until outer
transaction completion. An early sealed transaction can hold those locks beyond
expiry and delay rotation or retiring-key removal; there is no guaranteed
wall-clock key drain while such a transaction is held. This is an operational/DoS
condition, not authority for fresh writes or reopening sealed facts. Qualify
controlled-process transaction drain, held native traffic and failure recovery
before rollout, without weakening timeout checks or forced foreign termination.
If a rotation cannot preserve permitted in-flight work, hold native traffic
explicitly; never reinterpret signature failure as a typed child failure.

Readiness proves actual supported purpose/protocol/current key ID and signer+
verifier agreement through a narrow readiness operation that cannot persist
execution/publication facts or provide a signing oracle. Challenge/signature
possession alone is not readiness. Native compatible processes lacking the
permitted result signer must not claim/drain accepted native work. Deployment
rollback preserves a compatible result-signing/evaluation cohort or holds native
traffic; writer-OFF blocks fresh roots/publications but not compatible accepted
continuation/settlement. Old native accepted runs create fresh current proofs;
historical tokens/keys are never their recovery dependency. Retained nonnative
work remains unchanged and needs no capability.
Startup readiness uses only a fixed purpose-specific readiness domain, distinct
from either write domain, with the same installation/key facts and an expiring
server challenge. It cannot sign supplied arbitrary material, mint a write proof
or persist publication/execution facts. No third purpose key or generic signing
interface is introduced. A readiness MAC is never accepted by a native writer.

Restore requires privileged fresh installation identity and fresh challenges,
rejecting copied pre-restore proofs even if backend/xid numbers repeat. Reconcile
accepted native work with a compatible permitted signer before resuming traffic.
Keys are secret material, not workflow retention data; proof records have no
independent archive/history/retention obligation.

## Platform availability and qualification gate

Owned PG18.6 network-none/no-port tmpfs probe: pgcrypto available, uninstalled,
bytea HMAC unregistered, no keys or extensions provisioned, database removed.
Repository migrations currently do not install pgcrypto. Availability is not
approved installation or serving readiness. Verify target platform support and
approved extension schema/ownership separately; unavailable capability stays OFF.
PostgreSQL documents HMAC and side-channel limits; these constrain the claim,
not permission to provision. [Official PostgreSQL18 docs](https://www.postgresql.org/docs/18/pgcrypto.html).

Source-bound tests must cover actual API/worker database logins; valid publication
and each selector; raw SQL forged value/graph/executable/metadata/closure; missing
source/artifact and quota failures; copied token across purpose/key/installation/
backend/xid/tenant/run/version/revision/command/delivery/value/next-CAS; substituted
original bytes/normalized refs/content identities; duplicate consume; subtransaction
rollback; abandoned passes; full outer rollback/uncertain commit/replay; concurrent
rotation and active-ID/readiness mismatch; unknown/revoked keys; deployment OFF
and compatible accepted continuation; restore replay; retained nonnative flow;
privilege inventory, log redaction and bounded proof cleanup. No successful
normal-code-only or mocked verifier test closes the raw-role fence.
Include adversarial SET CONSTRAINTS IMMEDIATE followed by mutation/reconsume/
reopening attempts, clock crossing and rotation waiting on held outer transactions.
An early valid seal followed by later COMMIT is permitted only for its unchanged
closed facts; no test may claim a physical-COMMIT deadline or wall-clock key drain.

Accepted scope permits the two bounded trust implementations and owned-local
qualification with disposable generated fixtures. Source extension/grant/config
definitions may be authored for review; exclusively owned disposable databases
may install approved pgcrypto schema, ephemeral purpose keys and temporary
test-role grants, with explicit removable fixture ownership and no human resource
changes. Never put secrets in argv, logs, evidence, repository or committed
environment files. Permanent grants, registration, real key provisioning and
activation/deployment need separate exact-source inventory, primary review and
full F08 gates. No accepted family becomes dependent on a historical signer token.

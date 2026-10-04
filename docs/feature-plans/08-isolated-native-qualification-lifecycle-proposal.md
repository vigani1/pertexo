# F08 isolated native qualification lifecycle — accepted design

Status: **ACCEPTED DESIGN ONLY — 2026-10-04.** Primary fully reviewed exact
two-path diff SHA256 `f882585c3f04ff4fdc1b3eb036d81b910b1971defd1d2b76de3d3772da858934`;
independent Spec and Standards reviews reported zero actionable findings.
The [accepted ADR065 amendment](../adr/065-durable-parent-child-workflow-calls.md#isolated-qualification-lifecycle--accepted-design-only-2026-10-04)
changes no current implementation or permission. [F08](08-subworkflows.md),
accepted [ADR065](../adr/065-durable-parent-child-workflow-calls.md),
[ADR066](../adr/066-native-workflow-semantic-attestations.md) and their required
security/compatibility assertions remain authoritative. This is not an alternative
execution route for the platform-rejected integrity campaign, and does not resolve
its restriction. No installation commands or runtime implementation are proposed here.

## The concrete dependency

Fresh0137 entry requires exact installation approval and aborts before mutation;
its format/publication/command comments require qualification before installation.
`coordinator-native-readiness.ts` refuses before catalog checkout while its four
qualification blockers remain or the published constraint's qualified expression
identity is absent. `createCoordinatorRunStore` consequently cannot admit native
operations to earn the installed-behavior evidence that would clear those blockers.

Installation is not only additive native storage: the candidate replaces existing
artifact retention, concurrency admission, standard retention and workspace purge
functions, modifies published constraints/RLS and installs triggers/grants. Retained
API/worker/dispatcher startup pins old shared function bodies. Turning native off
does not isolate those changes in a serving database. Conversely, a dedicated
nonserving fixture can isolate exposure without declaring its implementation safe.

## Three stages and their separate gates

| Stage | Required admission facts | Permitted result; forbidden implication |
| --- | --- | --- |
| 1. Source/preinstall safety review | Exact source and shared-owner delta reviewed; explicit supported functional scope, ownership/cleanup contract, prerequisite matrix and later installation artifact approved | Eligible for a separately authorized fixture lifecycle; not installed or operationally ready |
| 2. Isolated qualification | Positively owned dedicated nonserving resources; approved installation contract; exact installed compatibility verified; all authority prerequisites for each case implemented/reviewed | Scoped real-resource functional evidence; not full F08, production registration, operational acceptance or rollout |
| 3. Acceptance and rollout | Every required functional, security, persistence/recovery, compatibility and lifecycle assertion closed on exact source; independent review and required CI/release evidence | Primary may accept implementation; production provisioning/activation remains a separate explicit decision |

Preinstall review checks source safety and approved scope. An assertion requiring
installed PostgreSQL belongs to post-install qualification, not a requirement that
it already passed before the approved fixture can exist. Moving its temporal gate
does not remove it. Current Fresh0137 abort stays intact: the executable installation
artifact and its exact guard/approval contract are a later decision requiring review,
not an instruction to strip the first statement or splice individual functions.

## One qualification module, a closed internal seam

Source-only orchestration owner: `infrastructure/testing/native-qualification-lifecycle.mjs`,
following existing infrastructure JavaScript/test conventions, not native TypeScript stripping.
It owns fixture identity, stage admission, approved case selection, evidence and
joined disposal. The database package owns an internal fixture admission adapter
through its existing testing surface, never a new serving export or public config flag.
Shared canonical coordinator composition would retain the same read/precommit/control/
CAS/receipt implementation; only lifecycle admission differs. No second reducer,
authentication implementation, SQL body or desired-outcome mock.

Conceptual interface, not an implemented/exported TypeScript contract:

```ts
qualifyOwnedNativeFixture(
  fixture: OwnedInstalledFixture,
  suite: ApprovedFunctionalSuite,
  signal: AbortSignal,
): Promise<ScopedQualificationReport>;
```

`OwnedInstalledFixture` is created only by the reviewed fixture owner after direct
resource and catalog observations. It cannot be constructed from caller metadata,
a DSN plus `test=true`, a supplied hash, or a certificate. It is a private local
resource handle, not SQL authorization or proof that the semantic module ran.
`ApprovedFunctionalSuite` names a closed reviewed case set with explicit prerequisite
and exclusion lists; no arbitrary callback, SQL executor, requested role or grant.
The report contains bindings, observations, coverage and failures, never secrets
or an operational readiness token. Case success is always `passed_within_scope`.

The installed-compatibility predicate checks the exact reviewed fixture manifest:
registered base checksums, separate candidate identity, all 67 native owner bodies,
shared replaced bodies, role owners/ACLs/search paths/forced RLS, constraints/indexes/
triggers, catalog and relevant process compatibility. Installed expression identity
is observed and independently checked against the reviewed expected constraint;
it is not copied into production expectations merely to make readiness pass.
The layered fixture manifest is not a fabricated registered migration head.

Compatibility and operational acceptance are distinct facts. The internal adapter
requires real installed compatibility, current fixture ownership and case authority
before every admitted lifecycle, then calls canonical operations with actual tenant,
delivery, lease, pin and pool-budget validation. Public `nativeReady` stays false;
its refusal list is not emptied, and no production factory option accepts the handle.
Lifecycle admission must be designed/reviewed before implementation; exporting raw
internals or setting `nativeReady=true` is not that design. Full production startup
and rollout qualification remain separately necessary.

## Target, source and least-privilege ownership

- Bind commit/tree, candidate SHA256, registered base/role templates, emitted process
  bytes and case manifest before resource creation. Any source/build drift blocks the
  run; new bytes need a new review/binding, not refreshed expectations mid-run.
- Use a dedicated task-owned PostgreSQL instance, not merely a database in a human
  or serving cluster: roles/grants are cluster-scoped. Positively identify its resource
  ID, creator, empty dedicated storage and network endpoints; names alone prove nothing.
  Reject production/human/shared targets, imported customer data and inherited serving
  credentials. Target uncertainty fails closed without mutation or destructive cleanup.
- Keep Redis, artifact storage, compatibility cohort and transport fixture-owned and
  disconnected from retained serving traffic. Use only approved provider doubles.
  Never attach public ingress or a live dispatcher/maintenance worker to shared data.
  Fixture retained cases are synthetic compatibility evidence, not retained traffic.
- The privileged fixture owner alone provisions the reviewed installation. Test
  application processes use distinct API/worker/dispatcher/maintenance identities with
  exactly their reviewed temporary least-privilege ACLs; no superuser/BYPASSRLS, owner
  membership, broad table write, generic signing access or grant widening to unblock a
  case. Owner credentials are never given to the canonical application adapter.
- Existing ADR066 purpose/key/process/verifier/transaction authority is preserved
  wherever a selected case requires it. Only separately approved ephemeral material
  in the exclusively owned fixture is eligible; no real key provisioning, reusable
  secrets, generic signer or credential logs. A different trusted SQL role does not
  replace the selected semantic-authority contract.
- Temporary roles, ACLs and any approved extension/key facts exist only inside the
  owned fixture lifetime. They confer no permission in any serving environment and
  are removed with verified fixture disposal. Do not modify registered migrations.

## Failure and cleanup contract

States are `blocked_before_install`, `installed_incompatible`, `qualifying`,
`passed_within_scope`, `failed`, `cleanup_failed`, and `disposed`; none means ready.
Precondition failure cannot start a case. Drift, wrong target, compatibility failure,
unexpected authority or an excluded request stops admission; it is not a retry with
weaker checks. Failure preserves original observations and cannot become a definite
child refusal or invented cancellation/timeout success.

Register ownership before acquiring resources. On stop, close case admission, abort
and join owned application work, queries/streams/evaluators and pool/process lifetimes
under existing cleanup contracts; record unresolved ownership rather than detach it.
Do not destroy resources while unjoined application work may still use them. Only
after positively verified ownership may the fixture owner dispose its exact resources,
including ephemeral role/key/grant facts. No broad path/namespace deletion or removal
based on a guessed name. Cleanup failure retains an actionable ownership record,
cannot count as successful qualification, and requires explicit recovery handling.

## Evidence and every still-required security assertion

Record exact source/installed/process/resource bindings, runtime role identities,
case prerequisites, actual durable observations, restart/replay outcomes and joined
cleanup. Distinguish real PostgreSQL/queue/object-store facts from bootstrap fixtures
and simulations; a constructed initial row is not proof of canonical publication,
root acceptance or admission. Offline normalized ASTs are grammar-only evidence.

All existing F08/ADR065/ADR066 assertions remain required, including semantic
publication/result authority, raw-login denial, purpose/transaction/replay separation,
seal expiry/rollback/receipt/current-result truth, immutable bytes/provenance,
current tenant/delivery/lease/pin controls, artifact quota/association/lifetime,
legal hold/retention/purge, parent/child recovery and retained compatibility.
Any assertion belonging to the rejected integrity campaign remains **excluded from
this execution scope and unclosed**, not renamed a functional case or attempted with
new tools, fixtures, processes or roles. The lifecycle cannot finish F08 while such
required evidence remains unavailable. No platform-access resolution is claimed.

## Unresolved prerequisites: no qualification start authorized

1. Design acceptance is recorded above; an exact supported case/prerequisite/exclusion
   matrix and bounded source implementation still require their scoped review.
   Design acceptance is not execution approval, and a user request to finish F08
   does not resolve the platform restriction.
2. Exact source/preinstall review and a separately approved executable installation
   artifact contract. Current guarded, unregistered Fresh0137 has no supported route;
   candidate chunks or a hand-cleared abort are not substitutes.
3. Reviewed installed-compatibility manifest and internal canonical admission seam;
   ordinary retained startup expects different shared bodies, while public native
   readiness is intentionally incomplete. Neither can simply be skipped.
4. Actual reviewed semantic/publication/root/initial-checkpoint authority for each
   selected positive case, including ADR066 where applicable. Current Fresh0137 is
   not an integrated, qualified ADR066 installation. Bootstrap rows, worker credentials
   or supplied semantic values cannot replace missing owners. If a case requires an
   excluded security assertion to establish its prerequisite, that case remains blocked.
5. Positively owned resources, pinned driver/pool budgets, transport/artifact adapters,
   least-privilege provisioning and joined cleanup demonstrated before case admission.

The lifecycle separation is an engineering proposal, not a guarantee that any case
is currently executable. Only design acceptance is closed here. Native catalogs,
execution and writers remain OFF; all operational gates remain open. No installation,
runtime tests, authority grants, key provisioning, activation, implementation commit
or push occurred at this proposal stage.

## First source-only case matrix — runtime admission remains blocked

The first tranche assesses source, ownership and compatibility observations and
joins cleanup. It exposes no case executor, installer, native startup or readiness
override. Injected resource/catalog/cleanup observations in its tests are simulations.
Existing canonical fixture ownership checks and native owner inventories remain
the source of truth, not new caller-supplied compatibility flags.

Every functional row requires reviewed installation artifact, installed full
compatibility, canonical native admission and exact approved execution scope.
Publication/root prerequisites must be earned by their actual owners, never fixture
rows. All those runtime prerequisites are currently unclosed; none of these rows
can run through this tranche.

| Closed case ID | Additional actual-owner prerequisites | Scoped future observation |
| --- | --- | --- |
| `call_wait_resume` | ADR066 semantic authority, canonical publication/root/Call admission, durable Wait/wakeup/transport | One pinned child survives wait/restart and parent resumes once |
| `parallel_control_reconciliation` | Canonical publication/root, physical completion and authenticated controls/clock | Existing branch truth reconciles without duplicate admissions or value demand |
| `artifact_result_lifetime` | ADR066 semantic authority, canonical publication/root, artifact preparation/association/result/quota owners | Accepted exact bytes survive result recovery and finite cleanup |
| `retention_family_resume` | Earned accepted parent/child facts, native detail/summary/purge/hold owners | Bounded interrupted pages retain then retire lineage without capacity resurrection |

The separate exclusion ledger covers `finalized_output_integrity`,
`logical_current_result_tampering` and `raw_login_semantic_attestation` from the
rejected campaign. They remain required/unclosed and cannot be selected, substituted
or routed through any functional row. Unknown/duplicate IDs also fail admission.
The matrix is source guidance, not approval of any runtime case. Source tests derive
checks for drift, dedicated nonserving ownership, inventory mismatch, missing
prerequisites, exclusion and cleanup failure from these requirements.

## Next source-only compatibility observation contract

The same assessor compares observations only with independently source-backed
expectations. `registeredBase` is `{head,migrations}` with the exact registered
names/source checksums already bound by the owner; the candidate stays separate.
`nativeRelations` names exactly the four relations in native readiness, each with
owner `pertexo_owner`, row/forced RLS true and four explicit empty table/column
privilege lists for PUBLIC/API/worker/dispatcher. `runtimeRoles` names the three
canonical fixture application roles, each with superuser/BYPASSRLS/owner membership
false. Missing sections are reported, malformed/duplicate/unknown rows rejected,
and concrete drift retained. No supplied `compatible` flag is authoritative.
Existing 67 function-body observations include the shared replacements, not just
new native functions. These checks do not qualify the entire installed catalog.

| Still unavailable expected fact | Existing owner that must close it |
| --- | --- |
| Exact function ACLs and volatility for the complete shared/native set; actual installed configuration qualification | Database native readiness / reviewed installation artifact |
| Complete role membership/ACL cohort including maintenance and lifecycle identities | Existing role provisioning / reviewed fixture installation |
| Qualified constraint/policy expressions, complete index definitions and trigger bindings | Database native published constraint/catalog inventory |
| Full emitted process/dependency bytes and compatibility cohort | Existing runtime-closure owner / qualification process manifest |
| Approved creator, empty storage origin, exact private network membership and disconnected transport/artifact resources | Existing fixture resource owner / reviewed installation contract |

Source hashes bind the existing role template, native readiness, retained shared
readiness, Dockerfile and runtime-closure owner; they are not qualified catalog
expressions or full emitted closure. Container observations can reject extra public
port bindings, privileged/host/container network modes; missing HostConfig facts
remain unknown. Even matching partial observations leave `complete=false` and
`dedicatedTargetVerified=false`. Exact missing facts above stop those subparts;
no source-to-observation copy manufactures an expected identity or positive isolation.

The per-function configuration mismatch is now corrected in reviewed source
(primary and independent review approved the exact frozen seven-path fix):
all 67 expected ordered `proconfig` arrays follow the reviewed candidate headers,
including the purge owner's `pg_catalog,pg_temp` path without `app`. Readiness
binds those exact arrays and rejects null or distinct catalog configuration; source
header consistency and simulated drift tests do not qualify installed behavior.
The existing four integration blockers and null published-expression identity
still refuse readiness before catalog checkout. The guarded SQL is unchanged.

The subsequent existing-summary-reader correction is a separately reviewed
source revision, approved after primary full review and closure of the narrow
Spec P2 with no Standards findings: Fresh0137 now supplies the missing API-only
`read_workflow_call_run_family(uuid)` owner, bringing the inventory to 68. Its
candidate identity is
`2abb17d82c0ced6b6ff056d7dfc64ac4dbce636c58757913ea286edd60f5a9c3`;
the new full metadata/body-profile digests are respectively
`5e4baefdc098baa4930c9f7a62acce160c23b47a6902c7e34e878ff69c5961dd` and
`aa44bd9df9eafd4a7695c94803d04d914c0bae54ece1e9c916e633f49a3b4825`.
The original 67-owner subset and previous receipts retain their original identities.
The reader returns summary-only links/status through existing trusted API tenant
read authority; it neither qualifies raw-login authority nor supplies execution
admission. Its unchanged summary helper and explicit VOLATILE wrapper use the
existing repeatable-read read-only transaction's visibility. The TypeScript
classifier now survives checkpoint expiry by binding the requested run's exact
pinned version. The reviewed narrow repair replaces the lossy native boolean
with closed decoding of actual version fields: only `1/null`, `1/2` and `2/3`
are accepted; missing, malformed, impossible or ambiguous metadata rejects before
family SQL. This repair does not change candidate or owner-inventory bytes.
All observations remain source/mock evidence; installation,
effective catalog ACLs/RLS, actual retirement and runtime admission remain blocked.

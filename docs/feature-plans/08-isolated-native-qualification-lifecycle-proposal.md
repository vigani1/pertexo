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

Proposed orchestration owner: `infrastructure/testing/native-qualification-lifecycle.mts`.
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

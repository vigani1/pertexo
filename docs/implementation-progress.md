# Backend Implementation Progress

Last updated: 2026-10-05

This is the mutable delivery tracker for
[`workflow-platform-backend-plan.md`](./workflow-platform-backend-plan.md).
A phase is complete only when its plan requirements and applicable
vertical-slice criteria have passed. Local checks never substitute for the
external production evidence listed under Phase 7.

## Current qualification

### F08 Phase 1 — registered inline JSON Call delivery (in progress)

The proven isolated local parent → pinned child → parent milestone is recorded
at `c118b93d5f2b55093591af3e678c3b0e16f7f20f`, with both persisted outputs
`{ "answer": 42 }`. It is not production qualification. The newly authorized
five-phase delivery program starts with a normally migrated, off-by-default
inline path and required real-PostgreSQL HTTP CI; ADR066 signed proofs and the
parked notification rewrite remain out of scope.

- [x] Reproduce the local path after actual development-stack restart.
- [x] Draft and exercise online tuple-index prerequisites and transactional
      inline Call schema through the normal runner on empty and populated 0136
      disposable databases; preserve existing data and six deferred owners.
- [x] Demonstrate and repair invalid concurrent-index restart and owner-role
      restoration between migration steps; migration-mode integration passes.
- [x] Qualify exact registered catalog/readiness on real PostgreSQL for API,
      worker and the inline coordinator, plus body/ACL/RLS/constraint/trigger
      mutation negatives; preserve default-OFF ordinary publication/root behavior.
- [x] Add ordinary staged/active Call successors after Validate (epochs 39/40),
      preserve retained fingerprints and remove source local-only readiness gates.
- [ ] Complete independent review and negative/readiness qualification of the
      exact extracted migration. No artifact/retention owner is included.
- [x] Replace the local-only cohort/env/readiness substitutions with ordinary
      registry transitions, exact normal readiness and a database-authoritative
      default-false writer/root rollout; accepted families must drain while OFF.
- [x] Add and locally exercise the dedicated no-skip real HTTP qualifier and
      required CI owner, including weakening/missing-owner policy negatives.
- [x] Close the eleven inherited complexity regressions through private,
      cohesive responsibilities without changing public interfaces or the baseline.
- [x] Synchronize generated problem-code artifacts and exact nodes-core test
      fixtures with the already-declared Call definition and policy.
- [x] Repair the changed-gate routing and stale source-only lifecycle metadata
      without altering the dedicated HTTP owner or deferred SQL candidate.
- [x] Complete the normal local pre-push gate on the recorded repaired tree.
- [ ] Run the real HTTP parent/child path in a required no-skip CI job.
- [ ] Record coherent reviewed commits, green CI and Phase 1 merge to main.

Observed test-first evidence: normal migration discovery initially ended at
0136; explicit post-online transactional mode was rejected; an interrupted
unique concurrent-index build was incorrectly recorded while INVALID. Focused
repairs pass the two empty/upgrade migration cases, eleven migration-mode
integration cases and twelve execution-plan cases. Real catalog negatives,
normal API/worker/inline coordinator readiness and ordinary flag-OFF publication
and root checks pass. Registry/config tests pass with newly pinned native
successors; a preexisting full-native source-only pin/assertion mismatch was
synchronized against the unchanged c118 candidate, without changing its SQL or
granting full-native readiness. These are prerequisite checks, not full F08 or
Phase 1 completion. The new disposable HTTP qualification passes one actual case:
normal 0139 installation, each append-only compatibility transition with real
API/worker probes, non-Call child publication OFF, fresh Call publication/root
503 refusal OFF, exact replays OFF, and real worker/dispatcher startup followed
by parent/child success while OFF with both persisted outputs and the exact pin.
The dedicated CI owner and thirteen weakening/missing-owner negatives pass within
39 CI policy tests. This is local execution, not a green hosted CI run. Whole
database/worker/API unit suites pass, and their
test typechecks pass. The obsolete local installer/repro are deleted (recoverable
in Git history); the existing historical local database is not migrated or reset.
Required hosted HTTP CI, independent review, broader qualification and merge
remain open. Production activation is OFF.

The Phase 1 Standards review found that an existing same-name online prerequisite
could use a non-default operator class, collation, ordering or null equality and
still be recorded as applied. The operator-class regression first resolved
instead of refusing. The runner now compares PostgreSQL's complete normalized
index definition with the recognized simple default shape, retaining owner and
target checks. Real PostgreSQL negatives preserve each mismatched index's OID
and leave migration history empty; exact invalid-index restart, committed-index
history recovery and normal 0139 installation still pass (13 combined cases).
This is a migration-runner repair only; 0139 and rollout semantics are unchanged.

The normal pre-push gate reproduced eleven source complexity failures on
`a50d9ad4`. Private publication projections, event identity/persistence, persisted
fact validation, bounded authoring job ownership, immutable registry history,
schema projection and compatibility setup now keep each owned file/function
within the unchanged budgets. Query order and transaction boundaries are
preserved; moved SQL is unchanged apart from claim-query indentation. Full
database units (185 files / 1,759 tests), worker units (106 / 1,333), workflow
model (1,572), node catalog (1,309) and contracts (240) pass. Eight affected real
PostgreSQL files pass 56 cases, and the rebuilt ordinary inline Call HTTP case
passes 1/1 with zero skips. Knip, architecture, builds and affected typechecks
pass. Two operator checks initially targeted the wrong local server; using the
same disposable-database endpoint passes without a code or test change.

Further inherited gate failures were stale generated contracts and nodes-core
fixtures, not refactor behavior changes. Normal deterministic generation adds
only the already-declared `workflow.calls_unavailable` enum value to nineteen
artifacts; freshness and built-consumer checks pass. The nodes-core fixtures now
include the existing Call policy rather than dropping its definition, and the
exact inventory adds only `core.workflow_call@1` while preserving the retained
eighteen identities. All 129 nodes-core tests pass. Normal `prepush:fast` on
`8269a609` passes static gates, changed-package lint/tests and dependent types,
but fails its final infrastructure batch (75 passed / 3 failed): the changed
selector runs the dedicated HTTP integration without its required owner
environment, and two source-only lifecycle assertions expect an old candidate
hash. The actual dedicated HTTP proof passes separately; the deferred candidate
blob remains `d264e871dd2c96b656e3f6e8367b417344a42096`.

The authorized follow-up from `3783d41d` excludes only that dedicated HTTP file
from service-free changed Node test execution while retaining its linting,
unconditional CI owner and strict no-skip reporter. A regression fails before
the routing change and passes afterward. The same source-only lifecycle tests
now pin the unchanged candidate's SHA-256, complete/retained owner inventory
digests and current registered migration head; count, installation guard and
false native-qualification assertions remain intact. The frozen owner inventory
and candidate are unchanged. Focused routing, lifecycle and CI-owner tests pass
70 cases, plus CI policy validation, lint and formatting. Full normal
`pnpm prepush:fast` passes on repair `f7bcdbf9`: static gates, build and all 45
built consumers, changed-package lint/tests, dependent typechecks and the final
84 infrastructure tests (zero failures/skips). The candidate blob is rechecked
unchanged after qualification. Hosted CI, independent rereview and Phase 1 merge
remain open. No baseline, timeout, migration or rollout setting is changed.

### F08 — ordinary execution-value runtime integration (incomplete)

Recorded source checkpoint `eb8c9def` (`feat: implement guarded native workflow
call source path`) contains the exact reviewed 100-path minimum-inline source
tranche. This is source recording, not execution or rollout qualification.
Branch `feat/subworkflows` has no upstream; no push was performed.

The reviewed retained-lineage source correction and selected-invocation read UI
are recorded separately in `52e96187` and `13f703f3`. The latter is verified with
controlled frontend fixtures only; installed native behavior remains unqualified.

The subsequent reviewed artifact follow-on is recorded in `c5d5a47f` and remains
unqualified. It now
composes actual tenant/Drizzle attempt reservation/finalization, the existing
writer/spool and shared bounded codec, including exact-candidate retry reuse and
accepted-source rereads outside SQL transactions. Coordinator declaration reads
carry artifact identity only; serial original-byte hydration runs before actual
engine Call control derivation in the same advance/evaluation/demand lifetime.
Adapter tests exercise one derived child intent, current-source denial and
cancellation/stale-owner stream destruction before engine derivation. They do
not establish child acceptance. Separate precommit validation now rereads the actual
accepted declaration and exact immutable pinned callee contract, releases SQL,
then hydrates/validates each detached value serially in the existing independent
precommit lifetime. This is application-composed validation, not protected-command
semantic authority. The accepted ADR065 clarification is separately recorded in
`ab698158`: canonical trusted precommit owns external-byte semantics; SQL owns
exact identity/current authority/lifecycle/atomic acceptance. The stronger
arbitrary-worker-command semantic guarantee remains unclaimed/open, not waived.
No truth flag/certificate is introduced.

The reviewed guarded artifact Call admission slice is recorded in `6a060f05`. It preserves inline
byte/contract guards and adds exact candidate/provenance/association/reference,
SHA/length/media, available lifecycle and current expiry checks. Candidate SHARE
precedes provenance SHARE, then artifact SHARE, through existing CAS/seal owners.
It removes only the operational artifact refusal under the accepted trusted-module
contract. Live protected SQL acceptance/COMMIT qualification remains open;
offline grammar and ordinary adapter tests do not establish it.

Coordinator storage is composed once only for an actual release-admitted native
read owner. Retained/native-OFF startup/readiness/drain do not construct or check
configured or borrowed storage. Native owned storage closes once after consumer
activity joins, including startup failure cleanup; borrowed storage remains
owned by its caller. Offline parsing verifies the fresh source grammar only;
its synchronized 60-function inventory is not installed-owner authority.
Native catalog/execution/writers remain OFF, protected SQL qualification remains
PAUSED. Physical-output and Wait source slices are reviewed/recorded; structured
source composition awaits review. Artifact/general result preparation and all
required real-service qualification remain open.

The reviewed Wait-read slice is recorded in `f4f16f9e` and remains unqualified. The actual
input loader now selects resume metadata under its resumed lease, and the source
adapter freshly reauthorizes that exact selection before shared-codec hydration.
Fresh0137 derives the immediately preceding accepted physical output from actual
`wait_resume` admission, running checkpoint invocation, predecessor success and
the durable `node.waiting` fact; it does not accept historical producer selectors.
Common source eligibility/artifact availability and current-consumer postchecks
remain in place. Targeted database source/parser/inventory tests pass 31 cases;
existing worker hydration/handler tests pass 23 cases; build/typecheck/lint pass.
These are application/external-pg and source-only checks, not live SQL authority.
Live Wait suspension/resume and structured collection qualification remain open.

The physical-output source slice is reviewed and recorded (`e145fd61`), including
the repaired artifact-replay identity finding; live qualification remains open.
Actual native execution now prepares physical values under its heartbeat signal
through the same framework codec/reserved writer, preserving retained outputs
and the separate Call input alias. Completion independently reconciles the
original producer bytes before SQL; only exact reference/SHA/length and original
inline text enter the guarded producer. Fresh0137 rechecks actual current lease,
native format, physical slot, exact live candidate and available artifact,
accepting provenance/association atomically with existing completion/receipt.
No preparation reference is authority; no decoded artifact payload enters write
SQL. An explicit post-owner cancellation check prevents subsequent success and
outbox writes, with the real tenant owner destroying the canceled connection.
External-pg/storage tests exercise actual tenant/Drizzle/codec/writer/spool and
completion for upload failure/cancellation, exact reuse without another pending
insert/charge, completion denial/cancellation and safe retry. Focused worker
5 files/51 tests and database 4 files/28 tests pass; builds, source/test types,
changed lint/format and architecture19 pass. Offline grammar202/63 is source-only;
complexity still fails the same five inherited hotspots, with no added hotspot.
The native Wait completion branch was extracted with the same owned signals and
post-preparation control inspection; it does not redispatch the executor.
Durable artifact completion replay now independently matches exact accepted
physical reference/SHA/length and scoped association under actual completed
attempt/canonical delivery/receipt truth before returning duplicate. It requires
no live lease, artifact hydration/availability, upload or second charge, and does
not compare a later logical node result. Actual completion-seam regressions cover
unchanged replay and same-ID changed bytes/length; bypassing the new guard makes
both negative cases falsely resolve duplicate, and restoring it passes all three.
The shared external-pg fixture was extracted without relaxing existing tests.
Artifact result/general selector composition and live qualification remain open.
The installation guard/nativeOFF/SQLPAUSED state is unchanged.

Native structured collection source composition is reviewed and recorded
(`86933c1d`) but remains unqualified. The actual input loader selects one slot-only
collection source; the
protected read derives every enclosing loop from the current running invocation's
iteration ancestry, branch prefix and active ordinal. It selects the nearest
waiting For Each barrier's succeeded physical attempt, matching the checkpoint's
exact inline-attempt or artifact declaration reference and accepted provenance.
The existing eligibility/association/availability and current-consumer postchecks
are preserved. No historical producer selector or decoded retained declaration
value authorizes this read. The adapter independently reauthorizes full source
and collection metadata before serial shared-codec hydration after SQL release,
under the same heartbeat signal. The existing retained count/checksum/ordinal
projector was extracted unchanged; native projection uses the existing V3 byte
owner and preserves unrelated opaque inputs outside an iteration scope.
Focused database7/72 and worker7/118 tests pass, including inline/large artifact
collection hydration, checksum rejection, current-consumer denial, cancellation,
changed collection identity and retained behavior. Actual completion-seam replay
tests also cover exact artifact physical replay after waiting/succeeded/failed/
canceled/timed-out/outcome-unknown logical node states, while changed bytes still
fail. Only native prepared artifact replay skips the logical-node status
comparison; the reviewed exact completed-delivery/provenance/association proof
must still return true. Retained/inline/Call alias replay owners are unchanged.
Builds/types/lint/format and offline grammar202/63 pass; complexity still fails
the same five inherited hotspots. These source/external-pg/storage tests do not
qualify protected SQL, live structured dispatch, atomicity or native enablement.
The coordinator hydrator explicitly rejects attempt-only Wait/collection slots
before any coordinator source read. Whole database unit tests pass177/1632 and
worker tests pass101/1282. Native coordinator structured declaration material and
independent pre-CAS validation, artifact/general result composition and required
live qualification remain separate unfinished gates.

Native coordinator result-source composition is reviewed and recorded
(`73c9cbc9`) but remains unqualified.
The independent precommit read freshly derives the pinned declaration, selector
and ordered selected sources, releases its short SQL read, and then hydrates
original bytes through the same selected-read and shared-codec mechanics under
the existing independent preparation signal. No first-pass context, result or
success flag is reused, and no nested lifetime is created. One existing JSONata
evaluator is allocated only for the actual release-admitted native read ports;
both evaluation passes share that resource, not material. Retained/native-OFF
allocates none, owned cleanup follows joined consumer activity and happens once,
startup readiness failure cleans up, and borrowed evaluators stay caller-owned.
Focused worker6/71 and database2/21 tests pass, covering fresh repeated original
byte hydration, identity drift before authorization, abort joining, lifecycle
ownership and fresh expression recomputation/contract rejection. The initial
artifact fixture incorrectly used noncanonical bytes; the existing codec refused
it, the fixture was corrected and the codec was not changed. General selector SQL
acceptance, artifact result persistence and coordinator structured declaration
material/pre-CAS validation remain unfinished. This composition is not protected
SQL or live qualification; nativeOFF/SQLPAUSED and the first installation abort
are unchanged.

The general-selector SQL source-read extension is reviewed and recorded
(`8f6b5133`) but remains unqualified.
The metadata inventory accepts bounded unique application-derived expression
dependencies, derives each actual immutable root/current invocation and accepted
physical or sealed Call result source, and includes original run-input identity
for expression context. General paths fetch the whole original source for existing
application projection; SQL does not parse JSONata dependencies or certify that
an arbitrary trusted-credential caller evaluated them. Existing borrowed-input,
exact descriptor, provenance, association, availability and deadline guards remain.
Offline grammar and source-contract checks are not execution qualification.
At that reviewed source-read checkpoint the final writer still refused general
selectors and artifact-result persistence; the newer uncommitted composition below
does not qualify them or the unfinished structured declaration/pre-CAS work.

Native artifact/general result composition is reviewed and recorded
(`4704b5db`) but remains unqualified.
Current result-candidate preparation independently reproves actual delivery,
pre/post revision and controls, preserves workspace/ancestor/current-run-checkpoint/
existing-receipt ordering, and reserves only bytes. It does not claim a receipt or
accept provenance. Exact pending/available retries reuse the candidate without a
second charge; shared mechanical lifecycle code delegates the existing pending
artifact quota and finalization owners for both attempt and result producers.
The actual runtime uses the same borrowed/owned framework storage, existing
reserved writer/spool and shared codec after fresh semantic verification inside
the same independent precommit signal. Verification carries the freshly recomputed
value into preparation; the proposed plan value is only an exact-byte comparison,
never the codec's producer value. The DB adapter derives result identity
from actual producer bytes and rejects prepared reference/hash/length drift;
artifact payload is never forwarded to write SQL.
The final SQL source accepts exact artifact candidate metadata and association
inside the existing CAS/provenance/receipt transaction. SQL-owned literal and
whole-inline selected-value contracts remain checked even for artifact output;
inline original-byte/binary64 comparisons remain when both values are inline.
External artifact-byte equality remains canonical fresh application preparation,
not arbitrary trusted-credential attestation or SQL re-encoding. General source
inventory is rederived from exact succeeded post-CAS invocations, eligibility and
locked accepted provenance/association/artifact identities, with final clocks.
Existing native prelock now uses the existing workspace status SHARE fence before
ancestor/current locks; no admission policy/counter or quota owner was added.
Whole worker103/1293 and database178/1655 unit tests pass; offline grammar208/66
passes only syntax. The initial result-owner fixture expected a different JSON
key order; correcting that fixture did not change production behavior. One new
runtime complexity hotspot was removed through cohesive evaluator-forwarding and
storage-binding ownership; the same five inherited hotspots still fail.
This source remains unqualified: protected SQL, actual quota/uncertain
COMMIT/CAS recovery, final-validation/COMMIT clock behavior and structured
coordinator declaration/pre-CAS work remain open. NativeOFF/SQLPAUSED, unregistered
Fresh0137 and its first installation abort are unchanged.

Minimum native Call executable path (source is not qualification):

Native coordinator structured-control source was reviewed and committed as
`50b8411f`, not a completed or qualified F08 checkpoint. Actual metadata-only
inventory/per-source read ports, serial original-byte codec hydration, private
bounded engine preparation, independent fresh precommit semantics and final
exact-source fences are integrated. The accepted ADR065 control-only clarification
separates physical success from logical ForEach cancellation/timeout, with no new
collection/loop/join/admission or declaration budget debit. Final acceptance
independently binds actual persisted controls/database deadline, pinned scope,
locked current physical attempt and original output; active descendant accounting
and unknown-effect priority remain intact. Four initial engine regression failures
proved the cancellation stall/deadline-demand bug before the repair; native
control regressions and active-loop reconciliation now pass.

One whole source unit run passed engine49/737 and database182/1707 before the final
physical-scope/Parallel-inline guard addition; subsequent affected database tests
and builds/typechecks pass. The actual handler/native engine/built tenant-CAS
adapter matrix passes20 cases for ForEach/Branch/Parallel cancellation/deadline,
inline/artifact (Parallel inline only), simulated committed-response loss and
repeated exact delivery, without demand, duplicate writes or declaration debit.
Its PostgreSQL rows/clock/COMMIT reply are externally simulated; it does not prove
protected SQL, real locks, concurrency, clocks or persistence. Source codec,
precommit, replay-mismatch and handler tests remain separate ordinary evidence.
New owned preparation/output-ownership/commit hotspots were cohesively removed;
the five inherited complexity failures remain visible, with no waiver. Exact
source follow-on repair was independently reviewed and committed as `2a338ae1`;
all previously listed live qualification gates remain open. Eight combined-chain
follow-on cases now cover existing active Parallel
joins under cancellation/deadline through later satisfied, failed and unknown branch
truth, and admitted child Call stop/control/event/outbox ownership through unknown
settlement and replay. They exposed two focused defects: pending stop projection
was rejected by the database validator, and later branch truth attached unsatisfied
metadata to a never-started canceled Merge that the engine parser correctly rejected.
The narrow repair independently proves locked pending/no-attempt/no-output/scope
state and preserves existing canceled native Merge identity while its ledger records
truth, without parser widening or retained changes. Twenty-two pending-proof cases
include forged control/status/attempt/output/scope/admission/debit negatives.
Current source unit runs pass engine49/737, database183/1731 and worker106/1329;
PostgreSQL I/O in the combined chain remains externally simulated, not live qualification.
The same five complexity surfaces still fail (status-validation597 lines and
commit-state220 lines/37 branches); no gate waiver or full-F08 claim. Fresh0137 is uninstalled/unregistered, screened SQL PAUSED and native
catalogs/execution/writers OFF; no push or full-F08 completion is claimed.

Current Fresh0137 source SHA256 is
`6588f2d8a6aa3fdb3e7c40bd5a01ca94f6ec92592fbc2e4fdbf0b8e8d25be5ba`.
Offline pglast8.4 checks parse219 top-level statements with symbolic roles
substituted only in memory; all67 owner signatures/body MD5/security-definer/
row-security expectations match the actual built inventory. Individual body
checks parse61/70 units after explicit in-memory namespace/rowtype normalization;
the nine trigger units initially remained unverified because pglast8.4 emitted
malformed JSON datum entries. A subsequent authorized isolated offline pglast8.5
check first returned usable valid trigger/integer control ASTs and correctly
rejected missing-semicolon controls with ParseError, then returned usable ASTs
for all nine unchanged normalized trigger units. Exact candidate, normalized
source and per-unit hashes match the8.4 diagnosis. This closes the missing-AST
tooling criterion;61 prior units and nine follow-up units are separate evidence
across parser versions, not a whole70-unit8.5 run. These are normalized grammar/
source checks, not embedded-SQL, database-binding, execution or live qualification.
Readiness remains refused before database checkout; its structured declaration
blocker now describes outstanding SQL/real-service qualification, not the already
integrated declaration/pre-CAS source. F08 remains incomplete.

The isolated qualification lifecycle design is accepted after full primary and
independent Spec/Standards review of exact diff
`f882585c3f04ff4fdc1b3eb036d81b910b1971defd1d2b76de3d3772da858934`.
It separates preinstall source/scope review, owned nonserving qualification and
post-install acceptance/production rollout. This closes design review only;
installation artifact, canonical qualification admission, ADR066 integration,
supported case prerequisites and actual runtime/security evidence remain open.
No guard, readiness, installed authority or platform restriction is changed.

The first lifecycle implementation slice is reviewed source-only after full primary
read/hash binding, Spec0, independent thirty-test verification and Standards
confirmation that its reentrant-close P2 is closed with no new narrow finding.
The repaired exact diff is
`2eff6713f2fd1638df0fad4385ad7206b7cf7da42a09b26f59896d76b9ddf0b7`;
its receipt is
`cfb1bd3ff906b0634d3d34d249f2d3c7f15894b6fff96730e9968171dc4ad498`.
Its closed four-case prerequisite matrix and exclusion
ledger precede the assessor tests. The owner binds actual Git commit/tree, guarded
candidate, registered migrations and selected source/emitted inventory artifacts;
reuses the existing canonical resource-ownership verifier; reports partial native
function-profile drift; and joins outstanding observations/application cleanup
before rechecking ownership and requiring exact resource-absence observations.
Fifteen source tests and fifteen existing ownership tests pass using injected
catalog/container/disposal observations, not real services. Matching simulated
function profiles still cannot establish installed compatibility or admission.
The full installed/emitted-process manifest, nonserving isolation, artifact
transport, installation artifact, canonical admission, ADR066 integration and
approved runtime scope remain explicit blockers. No runnable installation/startup
route, native-ready flag or case executor is provided; every runtime/security
criterion remains open. Primary explicitly authorized recording this reviewed
source slice; its tests do not authorize installation, runtime acceptance or push.

The reviewed slice also corrects reentrant shutdown: the shared close promise is
published before synchronous abort listeners can call close again. Its regression
first failed on distinct close promises, then passed with exactly one application
join, resource disposal and absence observation; admission still stops
synchronously and pending observations remain joined. Source-only evidence and
all installation/runtime restrictions are unchanged.

The compatibility/isolation contract extension is reviewed source-only after
full primary diff/test/doc/receipt read, hash verification, independent thirty-five
test verification and both review axes reporting zero findings. Its exact diff is
`470ab1bc13b9f654aa60bd022232afc34bbc2e3226fec4bcb1a4c155c404ad6d`;
receipt `186dc5a81cd31df37b80f4afb6a3edbd94f2b3eaa98a231399a59f297fbb36ce`.
Primary approved recording it without push or activation.
It binds the existing role template, native/shared readiness and
runtime-closure/Dockerfile sources; validates injected exact registered-base,
four forced-RLS/native privilege and three application-role observations; and
rejects malformed/duplicate/unknown identities and observed unsafe network modes
or extra published endpoints. Twenty lifecycle tests plus fifteen existing
ownership tests pass. Missing observations and five unavailable expected-fact
groups have explicit existing owners: full function/role ACLs and configuration,
qualified constraints/policies/indexes/triggers, full emitted process closure,
and creator/storage/private-network/transport isolation. Those subparts stop at
the missing facts; matching partial simulations cannot qualify installed or
dedicated isolation, and admission remains false. No installed SQL, live resource,
installation route or phase-completion evidence is claimed. Discovery included
one overly broad recursive source search that may have implicitly read the
quarantined draft without returning its content; it was disclosed to primary,
and subsequent work uses approved exact files only. No quarantine content is used
as a source, copied, hashed, installed or executed by this extension.

The routine per-function configuration fix is source-only and approved after
primary exact seven-path/header/hash review and independent seventeen database
contract plus thirty-six lifecycle/ownership tests, with no findings on either
review axis. Its frozen diff is
`89f23cc55d8f9419021d93e0777252dda683be4d0e9372500102d7b8e4f13f1d`;
the review receipt is
`34178bf947229fc4630b1179a8970d78c0ef47c11510af5f2fd7e6091974dee2`.
The existing native inventory now supplies exact ordered `proconfig` arrays
from all 67 reviewed Fresh0137 headers; the purge owner retains its app-free
`pg_catalog,pg_temp` path. Readiness compares each exact array instead of assuming
a uniform path and rejects null expectations or distinct actual configuration.
The source observer validates headers and compares rebuilt metadata; injected
null/missing/extra/unknown/reordered configuration observations fail exact matching.
Database build/typecheck and all 1,734 unit tests across 183 files pass, including
seventeen source-contract tests, as do thirty-six
lifecycle/ownership tests. The candidate hash, all original body/definer/RLS flags
and canonical prior body-profile digest remain unchanged; the new full metadata
digest is separately bound. Four integration blockers and the null published
constraint still prevent catalog checkout. Function ACL/volatility, qualified
installed expressions/definitions, complete role/process/resource manifests,
canonical authority/admission and all runtime/security qualification remain open.
No installation, live catalog, service or protected-campaign execution occurred.

The bounded lineage correction is recorded in `52e96187`, source-only and approved after primary full
ten-path review, zero Standards findings and closure of the narrow Spec P2.
The reviewed repaired diff is
`eb15ae742f501496b2e95e0248fa9c2fd6d2a2edcf3416edf83fec3ea04eadda`;
its narrow repair and receipt are separately bound as
`2b202802b2e9cf918359e37efa94a40eb12e8ee6c3f370fb547a6689dbf3105b` and
`1cbaa0103f4ee548d8d659c32c3041ef99ba15be43f8d2d864c15df518981e56`.
The existing authorized run-detail contract previously called a family reader
absent from Fresh0137, and its checkpoint-only classifier dropped still-retained
native lineage when detail retention deleted the checkpoint. The classifier now
binds the requested workspace/run to its exact immutable workflow/version; ordinary
retained formats never call native SQL, and unavailable or malformed version
metadata fails rather than manufacturing an empty family. Narrow Spec review
identified that a derived boolean silently treated impossible version pairs as
retained. The repair now reads the actual version fields and accepts only the
closed registered/native pairs `1/null`, `1/2` and `2/3`; missing, malformed or
ambiguous metadata rejects before family SQL. Fresh0137 now authors
the missing API-only summary reader, with explicit owner/revokes and fixed
configuration. It reuses the unchanged complete sealed summary-membership helper,
checks all retained run/version and admitted child pin identities, and returns
only the unchanged bounded links/current-status projection. It reads no payload,
provenance or cleared execution-detail pointers and grants no execution authority.
Both functions remain VOLATILE; stable visibility belongs to the existing
repeatable-read read-only workspace transaction, not a new SQL stability claim.
Database build/typecheck and 1,753 unit tests across 183 files pass, including
twenty-five family-reader and eighteen source-contract tests. Fifty API use-case/HTTP
tests preserve authorized forwarding, empty detail, run-only metadata and wrong
workspace denial; thirty-six lifecycle/ownership tests pass. These use external
database/persistence mocks and source observations, not installed SQL or earned
native runs. The current guarded candidate is separately bound as
`2abb17d82c0ced6b6ff056d7dfc64ac4dbce636c58757913ea286edd60f5a9c3`, with
68 source owners; the prior 67-owner metadata/body profiles and historical receipts
remain unchanged. No endpoint, wire schema, frontend or maintenance-helper change
is introduced. Exact installed ACL/RLS/function behavior, real detail retirement,
earned family data and all native activation/security qualification remain open;
the first installation abort and four readiness blockers/null constraint remain.

The selected-invocation read UI is recorded in `13f703f3`, tree
`1dc21a2fed85614e5ab64a742a89c4e71b152fd2`, after primary exact four-path review,
independent sixteen run-detail tests and zero Spec/Standards findings. Its frozen
diff and receipt are separately bound as
`6b759cdf7f8e0adb4c3d84f4e234a42ef593f01a68e9121f7ccd73223422cd8f` and
`457539846643d74cc6c912ae1f1fc09763b89f8eff5c8dcd5e59bf752a27b38b`.
The existing authorized snapshot supplies the step lens's accepted child link
and current reported status. Both node ID and exact invocation key must match;
absent or mismatched relationships render nothing. No new query, subscription,
endpoint, state owner, child operation or execution authority is introduced.
Ten workflow-run test files pass 82 tests, including repeated invocation
selection, current status refresh, five absent/mismatched relationship cases and
denied snapshot removal. Eight controlled Chromium history journeys pass,
including selected child navigation at 1440px and 390px; both settled views were
visually inspected. Build, production/test types, web lint, narrow format,
architecture and whitespace checks pass. React Doctor remains 100/100 after
repairing the new control-flow complexity in a private presentation component.
These browser fixtures do not earn native runs or qualify SQL, publication,
retention or rollout. No push occurred; native execution/catalogs/writers remain
OFF and full F08 remains incomplete.

The source-only lifecycle volatility revision is approved after primary full-delta
review, zero Spec/Standards findings and 23 independently passing lifecycle tests. The existing
assessor now binds a separate complete 68-function header profile: one immutable
binary64 leaf, one stable retention dry-run and 66 volatile owners, including
omitted defaults. Its digest is
`716110f6377625036757935e6c25c035aacd93306bc903da53361304ab9aaa8f`.
Existing candidate/body/configuration identities and production readiness remain
unchanged. Missing, null, unknown and changed injected volatility reports drift;
38 lifecycle/ownership tests pass. The missing full-function fact is now precisely
`complete_function_acl`; actual installed volatility/configuration and all ACL,
role, schema-definition, process and isolation qualification remain unclosed.
Matching observations still leave runtime admission false. No installation,
grant, native activation or excluded-campaign execution occurred.

The reviewed publication-denial tests and volatility profile are recorded in
`a626710f` and `9a3262f3`, respectively, with no push. A subsequent bounded source
audit leaves all five broader compatibility fact groups open: bootstrap does not
reconcile existing roles or pin a complete membership/default-ACL baseline;
local development output is not the separately installed production dependency
artifact; existing resource labels/tmpfs checks do not prove creator, empty
storage origin, exact private network or disconnected artifact transport. The
approved candidate replaces eight shared predecessor functions, not six; their
effective ACLs depend on predecessor state, not only candidate grants.

[Native logical projection fence](./feature-plans/08-native-logical-projection-fence.md)
closes the candidate source logical NULL, status and current-attempt pointer gap
with a defensive guard, not integrated or installed qualification. The normal
merge of Claude's `ead7d27b` source includes a review
repair: new or changed nonnull results must remain unrevoked and unexpired at the
SQL clock, while historical OLD-value lookup still permits legitimate retention
clears. Claude's original reported 14-scenario result does not qualify this
repaired source. The candidate remains unregistered with its first installation
abort; no campaign execution, installation or native activation is claimed, and
all five broader qualification groups remain open.

[Callable-target discovery and explicit exact-version Upgrade preparation](./feature-plans/08-callable-target-discovery-proposal.md)
is now accepted for bounded source-only implementation after primary full-read
review and independent Spec/Standards closure. It identifies an
opt-in existing version-read projection, exact immutable verified pin/contract
identity, separate current inspect/edit/publication permissions and truthful
target-local eligibility/unavailability, with publish-time revalidation. The
strict additive public contracts/artifacts and recursive projection correction
are reviewed and recorded in `ba69ad96`; 240 contract tests pass. The shared
model-owned two-slot queue/cleanup foundation is reviewed and recorded in
`609ca0bc`; 1,572 model tests pass, including independent measured-payload
admission and actual compiled-facade regressions. These source foundations do
not implement the API projection, final database authority, picker or actionable
Upgrade control. Native OFF, the source-only browser limitation and all
outstanding runtime/security gates remain.
The accepted design specifies one aggregate request budget, default-one
pages, off-thread owned verification outside SQL transactions, server-owned
default-OFF/native artifact capability, strict conditional OpenAPI/client response
variants and bounded dependency collection → stable locks → fresh reread.
The engine-owned fixed assessment entry and shared model-owned bounded lifecycle
preserve package direction; the exact internal scheduler seam was reviewed
before implementation. The engine-owned compiled assessment worker is reviewed
and recorded in `bfbc0b1c`, with 755 engine tests passing; its
source/envelope verification facts are not yet whole-closure/current-authority
discovery. Accepted proposal source SHA256 is
`2aadd9274c36f9456e50614dd992252f14d2889d8f3b841120af5fef4dfb875c`.
Design acceptance is not availability, native runtime, installation or readiness
qualification. The remaining owner-specific proposed regressions are not passing
implementation evidence. The independent publication-cancellation regression is
recorded separately in `7cf395bb`, after primary full review, zero Spec/Standards
findings and 17 independently passing focused tests. Our same 17 tests, test
typecheck, narrow lint/format and whitespace checks pass; production is unchanged.

| Path criterion | Implemented source | Actually exercised behavior | Remaining gate |
| --- | --- | --- | --- |
| Publication / compiler selection | WIP: actual publication owner validates callable selectors and bounded immutable closure; compiler chooses V3 for Graph2 | Ordinary public-owner positive publication, invalid selector, immutable pin/contract lookup and HTTP error-mapping tests; real V3 compiler verification | Installed format constraints, locked native release and adversarial publication authority unqualified; no real native publication qualified |
| Root acceptance / input | WIP: actual API manual-start version selection / verified initial CP3; existing canonical acceptance captures inline bytes before projection, accepts them after canonical claim completion and derives native family deadline; fresh guarded SQL owner | Real V3 verification / initial CP3; actual tenant/Drizzle/external-pg tests for byte capture, omission, rejection rollback and unchanged retained path | Protected SQL, real native acceptance and initial publication/command authority unqualified; native replay and other ingress qualification open |
| Call input acceptance | Fresh guarded 0137 record/read bodies | Actual tenant cancellation and JavaScript original-byte recovery tests | Protected SQL, binary64 agreement and normalized inline eligibility unqualified |
| Child admission / borrowed input | Existing canonical TypeScript owner now forwards its exact actual coordinator delivery through all private admission calls; fresh journal/binding schema | External-pg prelock forwarding and mismatched candidate delivery refusal before any SQL | Actual fresh protected admission/outcome/seal bodies, independent canonical delivery/current-state proof and atomic borrowed binding |
| Physical Call completion / logical result | Actual alias owner now enters before descendant locks; guarded fresh getter separates live completion from successful physical replay | Real tenant owner with external pg exercises commit, physical replay, rejection rollback and alias cancellation before descendant locks | Protected getter SQL and real concurrency unqualified; inline final-validation/COMMIT clock gap, exact nested invocation/publication authority and logical child result resolution remain open |
| Terminal parent result | Ordinary lazy demand/evaluator lifetime; actual inline attempt/source hydration composition and bounded precommit literal/whole-value result preparation; final guarded result writer remains inside existing CAS/receipt transaction; release-derived adapter admission requires actual pool K<=P and owner readiness | External-adapter lifetime/demand behavior; actual compiler/release fixture preserves retained history; real tenant/precommit/CAS composition with external pg tests fresh commit, exact recovery, stopped payload suppression and substituted-source refusal | Native owner readiness remains refused; artifact/Wait/structured support, general result selectors, real-service final CAS/recovery and protected SQL qualification remain open |
| Required retention | Guarded journal detail retirement, dependency-ordered detail pages and one capped atomic native-family summary unit; complete final existing retention/dry-run/purge bodies and artifact-owner extensions visible for review; latest purge wrapper preserves the registered patched delegate chain | Source-only body inventory/drift/bounds/purge-order checks; existing retention runner behavior only | Actual limit-one/partial/hold/mixed-family SQL behavior, direct replay lifecycle, native workspace purge and physical artifact cleanup qualification remain open |

All rows remain open. Native catalog/execution/writers stay OFF; 0137 remains
unregistered behind its installation-abort guard. Screened SQL qualification is
PAUSED and is not replaced by ordinary adapter tests. The recorded source
checkpoint above does not close any path milestone in this checklist.

Continuation evidence (2026-10-04): V3 immutable Call/control selection passes
12 model tests without upgrading retained V2 identities; four focused database
adapter suites pass 42 tests and typecheck. Nine additional source-contract tests
check the fresh candidate installation guard, complete visible retention bodies,
registered prior-body hashes, synchronized 56-function source inventory, native
family caps and metrics. They do not execute or qualify SQL. Native readiness
still refuses complete artifact/Wait/structured attempt sources, artifact
hydration/general prepared-result wiring and paused SQL qualification. The separately
authorized decision-only commit `81a5f9d` records detail retirement; the reviewed
minimum-inline source work and replay/family-unit clarifications are recorded
in `eb8c9def`. The reviewed artifact preparation/hydration follow-on is recorded in
`c5d5a47f`; its separate authority clarification is `ab698158`. Reviewed guarded
artifact admission and Wait source reads are recorded in `6a060f05`/`f4f16f9e`.
Physical-output follow-on source remains uncommitted and unqualified. No push was performed,
and the branch has no upstream.

The actual Call-material adapter additionally passes eight tests for immutable
Call-only selection, exact current consumer forwarding, control-stop byte-read
suppression and refusal of missing, duplicate or misbound protected replies.
Ordinary non-Call successes do not consume the 64-declaration request bound.

The subsequent existing-lease slice factors a private non-mutating attempt
consumer/producer proof and ancestor-first lock wrapper from the Call input
owner; immutable Call pin checks remain Call-specific. The actual input loader
now reads selected native sources sequentially with its real lease/delivery
carrier, preserving original snapshots rather than decoding retained columns or
fabricating coordinator authority. Six actual tenant/external-pg tests exercise
loading and independent hydration rereads. Minimum inline physical output now has
its missing guarded SQL body, ancestor-first completion prelock and deferred
distinct input/output-slot clock checks. A focused five-suite rerun passes 46
tests, database typecheck/build and narrow lint. These adapter tests do not prove
the new SQL semantics. At that minimum-inline checkpoint, Wait-resume, structured
inputs and artifact sources remained unimplemented; subsequent source work is
reported above, and native readiness is still not granted.

Coordinator production inline-source hydration now composes the same existing
codec with an independent protected current-owner reread, including inline
values. It has no fabricated writer/store dependency, no historical-ID authority
and no artifact-possession fallback. Five focused worker suites pass 105 tests
and worker typecheck. The same source-aware codec now composes the production
node-attempt runtime for inline input, Call preparation and Call recovery, without
fake artifact writer/store dependencies or preview/node capability exposure.
Four focused codec/input/runtime suites pass 116 tests. Complete artifact
hydration and all paused SQL qualification remain open.

Minimum literal/whole-input/whole-output terminal preparation now loads only
selected accepted original snapshots in the existing bounded native read owner,
releases that transaction before selector verification and encoding, then passes
plain original-byte parameters to the existing final CAS/receipt writer. Six
actual tenant/precommit/CAS adapter tests, simulating only external PostgreSQL,
prove read release before write, fresh record after CAS/before receipt completion,
exact full-plan recovery, stopped-consumer payload suppression and misbound source
rejection before the write owner. Detached material is not authority: guarded SQL
independently rederives the declaration, accepted sources and current controls.
Expression/path/artifact preparation remains explicitly unsupported, not complete.

The fresh source also exposes the complete latest 0135 workspace-purge wrapper,
adding one bounded dependency page at a time: associations, borrowed provenance,
Call journals, owned provenance, then candidate metadata. It preserves the entire
registered folders/organization/input-case/patched-base delegate chain and the
actual job/step lease, control high water and legal hold owner. Metadata deletion
does not perform physical object deletion or charge quota. Prior-body and exact
ordinary-body preservation checks are review tripwires, not executed purge or
limit-one/hold/concurrency qualification. The first installation-abort guard is
unchanged; no native owner, grant, release or serving cohort has been activated.

The current minimum-inline precommit/Call/attempt/retention source tranche passes
52 database tests across seven focused suites, database typecheck/build, worker
typecheck, narrow lint, 21 documentation checks (512 links / 138 files), 19
architecture checks and diff whitespace checks. The nine source-only retention
checks were rerun after their lint-only regex adjustment. None of this closes
the paused PostgreSQL authorization, lifecycle or COMMIT-clock qualification.

The original 83-file minimum-inline source freeze was **not approved**. Primary
and independent review found a truncated/duplicated SQL function tail, a mutation
lock in the nominal read proof, the still-restrictive registered published-version
schema constraint and missing whole-precommit lifetime composition. Its original
receipt/tests/reviews remain immutable historical evidence, not qualification.

A separate repair revision restores complete SQL grammar and removes every
mutation lock from the private attempt read proof. The mutating wrapper now
acquires ancestors before receipt/node/attempt locks and reruns that same proof.
The published schema constraint now permits only the paired Graph2/envelope3
native format with matching callable declarations; its retained schema1 arm is
exactly the actual registered 0012 predicate. Compiled graphs deliberately have
no authoring schema label. Constraint source expectations and catalog-readiness
coverage are explicit, with installed expression identity still unqualified/null;
native readiness continues to refuse admission.

The actual coordinator commit caller now requires a framework-owned preparation
scope for active native results. Runtime supplies the existing value-work lifetime
and actual owner inspector, independently of engine demand. Even literal
preparation initializes owner inspection, one watcher and whole-scope timeout;
owner loss, context abort or watcher failure joins owned preparation and prevents
any final acceptance. After preparation joins, the final short transaction does
only the existing CAS/receipt and independent protected acceptance rechecks, not
source hydration or evaluation. Inactive initial consumption still reads no
payload and can recover only through existing exact full-plan CAS truth.
Eight actual DB precommit composition tests and six framework-scope tests exercise
these cases; real-service resource/C/COMMIT qualification remains open.

Offline pglast8.4/libpg_query PostgreSQL18.4 grammar review parses the complete
fresh candidate as 193 SQL statements and 59 function/DO bodies. Five parser/AST
regressions reject the broken tail/checksum and malformed PLpgSQL CASE condition
and compare the actual old/new published constraint arms. The offline parser
expands role templates, uses a declared-return-type-only `record` shim for the
application composite type (body unchanged), and calls its raw PL parser because
its trigger-datum JSON dump is malformed. It does not resolve the application
catalog, install/execute any SQL, prove runtime type/security behavior, or replace
paused qualification. The first installation-abort guard remains intact.

The framework now composes the existing native execution-value codec with the
retained inline representation owner and reserved artifact writer. The ordinary
node-attempt runtime forwards its existing Call value dependency to the handler;
it previously dropped this dependency and failed committed snapshot recovery.
No node or preview artifact capability receives this framework-only dependency.

- [x] Compose preparation and hydration with the existing spool/upload owner.
- [x] Demonstrate the missing queue-runtime dependency forwarding test-first and
      preserve committed original inline bytes without preparation or recording.
- [x] Verify actual spool cleanup with successful upload/hydration, available
      reservation reuse, upload failure and cancellation using an in-memory
      object-store adapter and persistence callbacks (not real SQL authority).
- [ ] Implement and qualify native persistent artifact reservation/provenance,
      source-reference hydration, coordinator result integration and retention.
- [x] Review and record the bounded artifact attempt/coordinator source follow-on
      and accept the trusted precommit/SQL identity distinction (`c5d5a47f`,
      `ab698158`); the stronger arbitrary-worker-command guarantee remains unclaimed.
- [x] Review and record guarded artifact Call admission and native Wait resume
      source reads (`6a060f05`, `f4f16f9e`), without live SQL qualification claims.
- [ ] Review physical-output producer/completion source and qualify protected
      acceptance/atomicity/COMMIT and live suspension/resume behavior when permitted.
- [ ] Complete structured collection source composition and its qualification.
- [x] Accept the concrete ADR065 native artifact owner amendment and contract
      delta through primary and independent design review before persistent code.
- [x] Separate producer slots and coordinator pre/post-CAS result identity from
      consuming authority; recheck uploaded candidates without accepted-source
      authorization before acceptance.
- [x] Implement ordinary typed source projection and sequential worker hydration
      interfaces with source-aware authorization, required-descriptor checks and
      control/heartbeat ownership through native input and Call recovery reads.
- [x] Implement the pure bounded coordinator result-identity builder with the
      existing native encoder; leave authority and integration gates open.
- [x] Accept the coordinator demand ADR amendment and implement its first ordinary
      engine/wrapper/handler interface with typed stops and retryable queue behavior.
- [x] Implement the ordinary callback-scoped value-work lifetime with serial owner
      inspections, a whole-scope budget, deadline cancellation and joined cleanup.
- [x] Implement the unwired sequential decoded-expression helper with incremental
      existing-context bounds and owner-preserving cancellation composition.
- [x] Wire ordinary lazy native demand composition through the actual handler,
      runtime policy, codec and engine evaluator using external owner read ports.
- [x] Accept the native read operation / joined-cleanup clarification in ADR065.
- [x] Review and qualify ordinary selected native tenant-read lifecycle behavior.
- [ ] Compose it with actual native source/control owners and qualify readiness.
- [ ] Wire actual demand source/control adapters and the value-work lifetime, then
      implement independent native persistent commit preparation/rechecks.
- [ ] Complete all remaining F08 acceptance and rollout gates.
- [x] Review and record additive callable-target contracts and recursive generated
      descriptor corrections (`ba69ad96`), without claiming route availability.
- [x] Review and record the shared bounded authoring job owner (`609ca0bc`),
      preserving legacy validation and independently measuring queued payloads.
- [x] Review and record the fixed engine-owned assessment worker (`bfbc0b1c`),
      without claiming whole-closure assessment or final current authority.
- [ ] Complete whole-closure assessment, current authority/final fencing, the
      existing-GET projection, exact picker refresh and guarded draft-only Upgrade.
- [x] Review and record exact selected-invocation child link/status read UI
      (`13f703f3`), with controlled browser evidence only, not native qualification.

Worker build, source/test typecheck, narrow lint, formatting, architecture and
documentation checks pass. All 1,216 worker unit tests across 92 files pass. The
[F08 plan](./feature-plans/08-subworkflows.md) records this limited application
evidence. Native execution remains OFF; security qualification remains
platform-screened and PAUSED. This does not qualify durable artifact ownership,
real-service recovery, retention or full F08 completion.

Primary selected non-authoritative artifact candidates with atomic association
to accepted native provenance, distinct value slots and existing retention
extensions on 2026-10-03. Primary and independent Spec/Standards review closed
premature accepted-parent creation and abandoned-candidate family pinning. The
[ADR065 amendment](./adr/065-durable-parent-child-workflow-calls.md#native-artifact-ownership-amendment--accepted-2026-10-03)
and contract delta are accepted implementation guidance. Existing owners must
gain artifact-aware exact comparison/projection while retaining accepted-fact,
receipt, completion/current-authority and inline invariants, not weakened seals.
Persistent implementation and executable qualification remain unfinished.

The ordinary producer/candidate slice now requires `call_input` or
`physical_output` for attempts and distinct coordinator expected/result revisions
with a bounded result identity. Call preparation names its input slot. Upload
preparation reuses the exact reserve request to recheck current candidate proof;
accepted-source authorization remains hydration-only. Real codec/writer/spool
tests with external adapters reject hydration before simulated acceptance and
verify candidate disagreement fails preparation and exact available retries do
not upload again. These callbacks do not establish SQL authority or quota proof.
Focused tests pass (128 across five files), and all 1,057 worker tests across 85
files pass on the final rerun. The first broad run timed out in the unchanged
compiled-process bootstrap-failure case with no child output; its isolated rerun
passed all five cases without changing timeouts or assertions. Worker build,
typecheck, narrow lint/format and architecture checks pass. Persistent native
source projection, candidate ownership and full F08 qualification remain open.

The explicit source parser now preserves fixed native slots, immutable original
inline bytes, requested upstream scope order and physical-attempt versus logical
child-result identity. It requires the exact native grammar and distinguishes
absent stored run input from a missing descriptor. The framework's source-aware
codec requires accepted-source authorization even for inline values, checks exact
byte/reference agreement and delegates artifact reads to its existing bounded
stream codec. The worker hydrates sequentially under current consumption authority,
leaves retained JSON and structured/coordinator inputs unchanged, and fails closed
on missing source authorization or required descriptors.

The existing heartbeat owner now checks native controls/lease before value loading
or Call recovery and remains owned through reads, hydration and execution. A
regression first showed canceled recovery still reading a committed snapshot;
the correction refuses cancellation/timeout before read/hydration, aborts either
phase on lease loss, joins heartbeat cleanup, preserves original recovered bytes
and never remaps upstream inputs or hydrates unrelated native input sources when
a snapshot exists. The source integration passes all 1,477 database unit tests
across 160 files and 1,089 worker unit tests
across 86 files, package builds/typechecks, narrow lint/format and architecture.
These are ordinary adapter/parser/worker tests, not SQL role or durable provenance
qualification. The existing persistent input loader supplies no descriptors;
source-aware SQL authorization, candidate association, coordinator integration,
retention and usable persistent native activation remain unfinished. No SQL was
installed or registered; native execution is OFF and screened qualification PAUSED.
Prepared execution/control handling and shared value contracts now have cohesive
modules with unchanged public interfaces and one policy owner. This removes the
slice's new handler/codec file hotspots. Duplication qualification passes; full
complexity qualification still fails on eight inherited findings in six unchanged
coordinator/claim/input-loader files. No complexity baseline was weakened, and
this is not a full repository quality-gate pass.

Primary/Spec review also caught a missing-projection native fallback. Meaningful
regressions reproduced successful ordinary/retry/Wait completion without source
descriptors. Native handling now rejects that absence before dispatch, successful
completion or hydration, while preserving retained v2 behavior and the explicitly
authorized committed-Call snapshot exception. Fresh native Calls cannot use it.

The separate result-identity helper binds the accepted closed metadata record to
workspace/run/version, fixed result slot, actual delivery, pre/post revisions,
immutable selector, ordered physical/logical source references and admitted value
checksum/length/media type. It reuses the selected existing encoder, preserves
source order, checks whole-record 1 MiB/1,000-source bounds, and rejects extra
payload/clock/trace/plan fields. Identity is not authority. It is not yet wired to
coordinator result preparation, persistence or SQL; those gates remain open.
Its ordinary qualification passes all 1,124 worker tests across 87 files, build,
typecheck, narrow lint/format and architecture/duplication. The inherited eight
complexity findings remain, no baseline is weakened, and native remains OFF with
screened qualification PAUSED.

The accepted coordinator demand design is recorded in ADR065 and its concrete
companion. Its first ordinary interface requests exact selected material only
after pure success/unique root selection, rejects simultaneous eager/demand
configuration at runtime, and preserves literal/non-success no-demand and retained
eager behavior. Provider request data does not alias checkpoint facts; ready source
inventory/order must agree and provider-supplied evaluators are refused. Typed
cancellation/deadline/stale/context/unavailable work stops reach wrapper/handler
without a result plan or durable commit/acknowledgement. The actual queue adapter
keeps these stops retryable. Framework-only adapter composition supplies actual
canonical delivery and workspace/run/version; absent native adapter fails closed.
Ordinary tests/builds/typechecks/narrow lint pass, not persistent authority proof.
The existing database eager loader is unchanged. Actual source/control SQL,
watcher/deadline/abort-join policy, incremental context hydration, independent
persistent native commit preparation/final rechecks and literal stalled-upload
cancellation proof remain open; native stays OFF and screened qualification PAUSED.

The separate ordinary value-work lifetime now owns serial external owner reads,
a single monotonic whole-scope budget and an actual-owner deadline cap. It aborts
active streams on cancellation, context shutdown or a stalled control read, and
joins watcher, read and operation cleanup, including dropped operation promises.
Local deadline expiry is unavailable until a fresh owner read supplies a durable
stop; it cannot invent a timeout fact. Literal demand callbacks with no operation
do no inspection, while preparation operations use the same precheck and watcher.
At that standalone checkpoint the module was unwired; it cannot classify accepted
receipts or final CAS results.
Ordinary lifecycle tests cover real Node streams with injected external adapters,
not persistent codec uploads or SQL authority. Actual adapters, configuration and
engine/provider composition, incremental context, final-CAS exact receipt/full-plan
truth and the actual literal-preparation stalled-upload regression remain open.
All 1,165 ordinary worker tests across 88 files pass, including 32 lifecycle cases.
Worker build/typecheck, narrow lint/format, documentation, architecture and
duplication checks pass; full complexity still fails on the same eight inherited
findings, with no new lifecycle hotspot or baseline change.
Native execution/catalog/writers remain OFF; screened qualification remains PAUSED.

The existing worker configuration now parses the three accepted native value-work
policy fields, freezes one policy and forwards it into coordinator runtime options.
That foundation provided parsing/forwarding only; operative demand consumption is
recorded below. It adds no activation flag or persistent inspector.
A separate ordinary composition regression now combines the actual execution-value
codec/writer, real spool files and a cancellation-aware stalled upload with the
value-work lifetime for an above-inline literal. It verifies precheck before reserve,
watched cancellation, destroyed/closed upload streams, joined spool cleanup and no
finalization or hydration authorization. It exposed the same pipeline abort object
being aggregated twice by upload and cleanup. The cleanup owner now preserves that
exact signal-linked abort; independent spool cleanup failures remain observable as
aggregates. These external adapter callbacks still do not prove SQL provenance or
production handler/final-CAS integration, which remain open.
The combined ordinary source candidate passes all 1,180 worker tests across 90
files, worker build/typecheck, narrow lint/format, documentation, architecture and
duplication. Config-file growth briefly introduced an owned complexity regression;
moving its unchanged scalar-environment normalization into a focused config helper
removed that growth. Full complexity still fails only on the original eight
inherited findings; no baseline or verification timeout is weakened.

Verified ordinary editor/CI release changes were reconciled through additive merge
`39740c8`, preserving the exact released blobs and accepted native stop contracts.
At its standalone checkpoint, the decoded-expression helper was unwired: external reads must establish
source and current consumption authority. It reads selected sources sequentially,
checks the existing final record/context bounds after each decode, and stops before
the next read once invalid. Exact byte/depth/member boundaries agree with the actual
evaluator; original inline whitespace bytes remain independent of decoded limits.
A meaningful lifetime-composition regression caught invented `context_aborted`
classification after owner cancellation. The helper now reports ordinary abort and
joins the pending decode; the lifetime preserves the actual owner's typed stop.
All 16 helper tests and all 1,196 worker tests across 91 files pass, with worker
build/typecheck and narrow lint/format passing. This is ordinary external-port
qualification, not SQL authority, runtime policy consumption or final-CAS proof.
Those integration gates remain open; native stays OFF and screened checks PAUSED.

The ordinary native demand pipeline now consumes the parsed policy in the actual
runtime/handler and keeps one lazy scope through source hydration and engine-owned
isolated evaluation. Its callback-scoped signal is cancellation, not a grant.
Literal/non-success engine-demand advances do no new owner/source inspection; demanded work checks
current owner before I/O and rechecks after evaluation before a plan escapes.
The existing run-store contract has optional actual-owner/inventory/per-source read
ports; production deliberately omits them, so demanded native work fails closed.
An unscoped decoded-loader dependency cannot bypass this lifetime at runtime.

The reviewed source-port refinement returns only bounded source identity metadata,
never all inline snapshots up front. One protected original snapshot is fetched,
validated and hydrated before incremental context validation permits the next.
Ordinary real engine/codec/evaluator tests observe only two of three over-bound
snapshot fetches; six whitespace-heavy original inline snapshots remain eligible.
Cancellation joins a stalled fetch or actual isolated worker termination, and late
owner revision change discards an already evaluated success plan. Missing ports or
codec fail closed; payload-bearing inventory and differing fetched identity fail
before object reads. All 1,216 worker tests across 92 files and 128 affected database
unit tests pass, plus package builds/typechecks. These external adapters prove
composition, not persistent authorization, quota/provenance or SQL resource cleanup.
The existing database `loadAdvanceState` still eagerly invokes the native callable
material loader before this scope and can decode selected original snapshots in
pages. Removing that native eager projection (while preserving retained behavior)
is a prerequisite for a bounded, lazy persistent path; these adapter tests do not
qualify that earlier database state-loading stage.
The generic abortable checkout's late-disposal hook is not proof that a pending
checkout has joined; actual read-owner implementation must own that resource.
Independent precommit computation/result candidate preparation, exact receipt/full
plan CAS truth, atomic accepted association, retention and real-service end-to-end
qualification remain unfinished. Native remains OFF; screened checks remain PAUSED.

The next focused persistent prerequisite suppresses native eager callable result
material from the actual `loadAdvanceState` read adapter, removes its unused
run-input column and retains callable declaration validation. Eight adapter tests
cover selectors, validated controls, malformed declaration and retained cleanup;
54 focused database tests, build/typecheck and narrow lint pass. This does not
remove existing physical/fact/control or Call-declaration validation. Logical
Call physical-state validation still reads the protected original result
reference before demand, so total bounded persistent state loading remains open.
The suppression passed exact source and independent review and is recorded in
`e2ae249`; no native read owners or SQL are installed.

The lifecycle slice recorded in `5bd2d8b5` implements the accepted native-only budget
inside the existing tenant-read adapter. It refuses incompatible actual pool
acquisition settings, uses remaining monotonic SQL time, prevents late success,
joins raw checkout and delivered-client/CancelRequest termination, and retains
ownership after cleanup allowance exhaustion while preserving independent errors.
Driver delivery callbacks register client termination before promise continuation;
ordinary transaction mode remains unchanged. Focused adapter/transport tests are
not persistent authority or real-service socket qualification. Exact primary and
independent reviews closed the non-abort destruction and cleanup interruption
findings; 68 focused tests, build, source/test types and narrow lint pass. Actual
native owner composition, one whole-value-scope cleanup deadline and safe
resource/readiness qualification remain open. Native remains OFF and screened
security checks remain PAUSED.

A fresh unregistered `0137-native-execution-values.candidate.sql` now starts from
the actual registered schema, with an explicit installation-abort guard. Its
source groups define complete slot/owned/borrowed shapes, exact run/node/attempt
foreign keys, non-authoritative artifact candidates with a separate atomic
accepted association, and a Call journal whose sealed admitted child identity
constrains the borrowed binding. Primary selected the bounded child-input
clarification; no duplicate original-byte store, quota or reference kind is
introduced. An extension of the existing retention owner handles definitively
abandoned unaccepted candidates after physical deletion; accepted or unresolved
native values conservatively remain protected. This is source-only, not SQL
qualification or completed consumer/family/replay eligibility. The candidate
remains incomplete: authenticated journal ingress/seal, complete protected writer
and reader integration, publication authority, complete retention/purge and readiness remain
required before exact review can authorize installation. The
quarantined 0136 draft remains excluded and unchanged.

The actual Call declaration input writer/read adapters now check cancellation
again after the awaited workspace admission lock, preventing protected SQL from
starting on an already released client. A regression through the real tenant
transaction owner, simulating only the PostgreSQL boundary, reproduced both
paths before the guards and verifies no later SQL and exactly one destructive
release. Focused adapter tests and test types pass. This fixes owner composition
behavior only; it does not supply or qualify the missing protected SQL bodies,
native ingress semantics or publication authority.

The next source revision now implements the existing Call input record/read SQL
signatures, deriving actual run/version/node/invocation/current lease, bounded
sealed ancestor lineage, durable controls and canonical attempt delivery/receipt.
Inline ingress preserves original bytes, checks PostgreSQL18 unique-key JSON
before conversion, bounds depth/members and compares numeric leaves as binary64
with an exact zero-underflow threshold. Artifact acceptance requires the exact
available candidate and inserts its association in the existing transaction;
replay preserves the first projection and immutable byte identity. The prospective
source includes scoped owner-only RLS and just the two existing worker command
signatures, not runtime table access. No permissions are applied: these SQL bodies
remain unexecuted and unqualified behind the installation-abort guard.
Structured invocation assumptions, differential numeric/platform behavior,
normalized inline eligibility and adversarial publication/table authority remain
explicit review gates, not solved by version labels or these source guards.

Shared original-byte recovery now independently rejects duplicate object keys,
including escaped equivalent keys, while preserving legal repeated keys in
separate objects and JSON-looking strings. Its public recovery regression failed
before the change despite correct SHA/length and a matching last-key projection;
the ordinary JavaScript tests now pass. This is not a differential SQL platform
test or a rerun of paused raw-tampering qualification.

The minimum-path source now also integrates native callable/closure validation
in the actual publication owner, actual API V3 compiler and initial-checkpoint
selection, and manual-start version selection. It does not register a native
release: retained serving releases still reject native graphs. Canonical root
acceptance captures inline-or-omitted original material before JSONB projection
and invokes its fresh protected root-input command only after the same
transaction's run/checkpoint/outbox/idempotency completion. Native duration
defaults derive from the immutable family policy; existing caller deadlines
remain minimum caps. The actual tenant/Drizzle tests simulate only PostgreSQL
and verify original-byte forwarding, absence, rollback on protected rejection
and unchanged retained behavior. Real V3 verification / initial CP3 and ordinary
publication tests pass. These are application/adapter qualifications, not SQL
authority or a completed native Call path. The root command's prospective API
and worker grants are additional unexecuted source statements; no permission,
schema or release has been installed.

The actual coordinator admission preparation now transports the existing
`CommitAdvancePlanInput.delivery` unchanged to prelock, admission, reservation,
outcome and seal commands. It is a private carrier, not authority: those fresh
protected bodies must independently prove the actual canonical payload/checksum,
receipt, current revision and controls. Candidate/context delivery disagreement
fails before any SQL in external-pg adapter tests. Child acceptance idempotency
and the existing full transition fingerprint owner are unchanged.

Physical Call completion now enters its existing protected alias getter before
outer receipt/current-run/node/attempt locks. A test-first external-pg regression
demonstrates denial rolling back before those descendant locks or any physical
write, and cancellation releasing the joined client without descending. Existing
completion tests now use the real tenant transaction owner with only external pg
simulated; positive completion commits and physical replay remains write-free.
The fresh guarded getter prelocks only ancestors first, then preserves
receipt -> current run -> node/attempt ordering. Actual successful physical
outcome, event, canonical delivery and first-input output equality select replay;
cleared leases and subsequent logical child results do not select live-owner
checks. Live completion reuses current input-owner lease/control proof after
ancestor locks are already held. The getter body and prospective existing
getter grant have not been installed or exercised against PostgreSQL; source
checks and ordinary adapter tests are not SQL authority/concurrency qualification.
The final live validation still precedes the ordinary physical writes and COMMIT;
it does not close the inline lease/deadline commit-gap qualification gate.
Logical child result resolution and the complete native path remain unfinished.

The current focused F08 responsibility cleanup removes the new/worsened owned
complexity hotspots without changing the baseline or public execution interfaces.
Selected native result context, immutable publication closure, bounded value
decoding, pre-write result preparation, independently rechecked observation
assembly, selected completed inputs, structured collections and protected
completion prelocks now have cohesive internal owners. Exact comparison against
`81a5f9d` reports no new/worsened hotspots. The full gate still **fails** on five
findings already present at that commit (two coordinator files, commit-state
locking and two attempt-claim functions), down from the pre-cleanup live 15 and
the commit's eight. The overlapping commit/input-loader extractions also remove
three inherited findings; this is not a full repository quality-gate pass.
Focused external-pg/worker regressions, source/test types, narrow lint and
architecture checks pass. The reviewed 89-file source snapshot remains unchanged;
these later extractions are separate evidence, not an alteration of that review.
No SQL installation, native activation, complexity waiver, commit or push is
performed. Full F08 remains incomplete and screened SQL qualification PAUSED.

### F02 — run-input cases and version-checked manual start

The manager accepted the product owner's version-checked explicit real-start
direction on 2026-10-01. [ADR061](./adr/061-workflow-input-cases-and-checked-manual-start.md)
and the [F02 first-slice plan](./feature-plans/02-workflow-test-workspace.md#first-slice-run-input-cases-and-checked-real-start)
record shared version-contextual cases, detached loaded intent, legacy omitted-field
compatibility, accepted-result precedence, serialized manual keys, committed
24-hour stale rejections, retained-byte quotas and lifecycle/rollout gates.

- [x] Inspect merged main `5f78e155` and resolve the first-slice product direction.
- [x] Record the accepted design and amended implementation/acceptance plan.
- [x] Obtain manager review of planning commit `05002263` and implementation
      authorization on 2026-10-01; both independent planning reviews had no findings.
- [x] Implement contracts, current authority, storage and checked admission.
- [x] Prove focused real persistence/race/expiry/hold/purge and pure-node browser behavior.
- [x] Complete frozen-source repository checks and coverage qualification.
- [x] Repair manager-release rollout and denied-case retirement blockers with
      focused component and real-browser regressions.
- [x] Complete independent reviews and combined F02/F05 migration qualification.
- [x] Complete scoped release and natural-main evidence through combined PR145.

The accepted first slice is locally qualified, independently reviewed and released
through combined [PR145](https://github.com/vigani1/pertexo/pull/145). Pure F02
[PR144](https://github.com/vigani1/pertexo/pull/144) at `085fa974` passed all 14
hosted checks and remains open/superseded, not separately merged. Backend commit `82f3618b` and UI/browser commit
`b555f994` record the reviewable first-slice implementation.
Migration 0130 owns shared immutable-version case metadata, retained payload
revisions and 24-hour mutation receipts; 0131 owns serialized manual identities,
terminal stale receipts and the all-manual-writer fence. Both case changes and
new checked starts default off. Disabling them preserves exact success/negative
recovery and ordinary omitted-field admission on compatible writers.

Focused evidence on 2026-10-01: real PostgreSQL case tests 17/17 and checked
manual-start tests 31/31 pass; real authenticated HTTP tests 4/4 and the owned
browser/API/worker journey 1/1 pass without skips. The latter proves detached
input, stale v1/v2 rejection, actual accepted-response loss, v3 republication and
exact recovery of the one successful v2 pure-node run, including an actual
390px-wide retry with visible recovery controls. Contract and API tests
prove omitted-field hash bytes, strict bounds/CAS and safe Unicode-name rejection.
Independent scoped reviews found and repaired unsupported Unicode names, a NULL
cleanup limit that could remove the batch bound, an asynchronous publication-review
display race and Enter in a case-name editor implicitly submitting the real-run
form, plus publication review clearing a stale loaded-case boundary. A changed
context now requires deliberately loading a distinct current-version case;
review or creation alone cannot adopt the stale copied input. Contract, real
HTTP/SQL and component regressions retain these boundaries;
the final browser journey passes after the UI repairs. The manual SQL review had
no findings. Serialized repository coverage passes all 24 TypeScript cohorts at
`sha256:4149d6361b6263f797ab2de6d32f24386ad7f1f1e3a1d78a852a6304d5561e8d`,
with zero unreviewed and 388 unchanged reviewed risk branches. Full PostgreSQL
integration coverage passes 850/850 across 110 files without skips.

Earlier concurrent attempts remain recorded: bounded compiled-worker/UI-loading
waits failed under competing full suites, and one cancellation-fixture connection
count raced an independently started telemetry pool. The latter now uses an
owned monitor-disabled runtime, preserving the same zero-checkout assertion.
No timeout, assertion, coverage threshold or risk exception was weakened.
The complete repository check passes with
`pnpm_config_workspace_concurrency=1 pnpm check`, including web 860/860, API
1854/1854, database unit 891/891 and worker 903/903. Installed-browser probes pass
7/7. The full mock-browser suite passes 90/90 across Chromium and Firefox/WebKit
smoke lanes with one worker and retries disabled. The React Doctor result is
93/100 with one remaining run-dialog control-flow maintainability warning, not
a suppressed diagnostic or observed behavior failure.

Source-bound qualification evidence is preserved outside the checkout at
`/Users/vigan/.codex/evidence/pertexo-f02-2026-10-01/`: the package-serialized
repository check, serialized repository coverage, PostgreSQL integration coverage
JSON/log, strict case HTTP/browser gate JSON, full mock-browser JSON/log and three
inspected desktop/mobile PNGs. Browser proof uses the final stale-case/Enter
barriers and verifies actual accepted-response loss followed by exact v2 recovery
after v3 publication; it is not a mocked admission result. Owned disposable
fixtures are cleaned up independently of the preserved live user work.

Manager whole-branch release review subsequently found two blockers. Fix
`ea94c399` makes denied reads, denied mutations and lost mutation authority use
one retirement transition that clears pending/retained state, fences late results
and keeps sensitive input hidden while allowing dismissal. Fix `c2dacbbe` uses
the existing input-case list endpoint's gate: deliberately confirmed ordinary
Run actions omit the version precondition when rollout is unavailable; pending
or other failed reads cannot imply that mode. Loaded cases and previously
submitted checked commands never downgrade, and frozen checked or unchecked
recovery retains the original intent. No new discovery endpoint or rollout
enablement was introduced.

Post-review qualification passes 20 focused component tests, all 872 web unit
tests, build/typecheck/lint and the 90-test mocked browser suite with no skips,
unexpected results or flaky retries. The extended authentic browser/API/worker
journey passes and verifies four distinct successful ordinary pure-node runs
(both Run menu actions under default-off and rollback), plus the original exact
checked accepted-run recovery after rollback. Case-query metadata still retires
with its owner; SPA navigation preserves the browser/session lifetime, not an
evicted case snapshot. Mounted-query true-to-unavailable behavior is covered by
the component regressions. Fixture navigation, initial API-publication snapshot
and hydration/locator failures remain retained separately; no timeout or assertion
was weakened. Doctor reports only the existing run-dialog complexity advisory;
the current focused scan disables scoring and does not establish a new score.

The original broad repository/coverage and 850-test PostgreSQL evidence above
binds candidate `8af0190d`; it was preserved, not rerun or relabeled for these
frontend repairs. The source-bound post-review receipt and new exact-source
browser evidence are recorded separately at
`/Users/vigan/.codex/evidence/pertexo-f02-2026-10-01/release-blocker-qualification-receipt.md`.
Manager re-review, hosted CI, scoped release and inspected natural-main are now
complete through PR145 as recorded below. The experimental CI runtime prototype
was neither published nor triggered. Broader F02 work and production activation
are not implied by first-slice release.

The owned `feat/workflow-input-cases` branch and disposable PostgreSQL/Redis
services are separate from live user work. No production enablement or provider
execution is authorized. Preview pins, recorded samples and regression
assertions remain deferred; existing backend phases stay unchanged.

### F05 — same-workspace workflow duplication

The user approved a fresh workflow identity with preserved internal graph IDs
on 2026-10-01. [ADR060](./adr/060-workflow-duplication-identity.md) and the
[F05 first-slice plan](./feature-plans/05-workflow-portability.md) define the
atomic command, source selection, authority, replay and verification contract
against starting merged main `0f54e31d`. This is a saved draft/chosen-version copy
into an independent unpublished draft, not import/export or automatic activation.

- [x] Reconcile the existing authoring/model baseline and resolve graph identity.
- [x] Record the accepted first-slice decision before implementation.
- [x] Implement atomic persistence, contracts/API and the browser command.
- [x] Prove isolation, races/replay and enabled live browser/backend acceptance.
- [x] Complete independent reviews and green exact-head/natural-main release.

The first slice is independently reviewed, merged through
[PR142](https://github.com/vigani1/pertexo/pull/142) and qualified on natural main
`5f78e1552c55fede6f04264f8be4197296629e9c` (merged 2026-10-01 at 15:06:01 UTC).
Both review axes closed all findings on `a766f585bdfe86cace8747b85818173a51629629`;
all 14 exact-head checks passed, including
[CI 36878945569](https://github.com/vigani1/pertexo/actions/runs/36878945569) and
[CodeQL 36878945724](https://github.com/vigani1/pertexo/actions/runs/36878945724).
Natural merged-main [CI 36881611828](https://github.com/vigani1/pertexo/actions/runs/36881611828)
and [CodeQL 36881611922](https://github.com/vigani1/pertexo/actions/runs/36881611922)
also passed on that exact main SHA. Main CI's real workflow duplication browser
journey validation and report upload succeeded.

Original local evidence on frozen `06ca64c1` includes 25 enabled PostgreSQL cases
(atomic rollback, source/catalog/membership
races, replay, defaults, ACL/readiness drift, populated 0128→0129 upgrade,
legal hold and workspace erasure), all 113 enabled ordinary API integration
cases, 142 contract tests, and 831 web unit tests. The enabled real-browser
duplication gate passes one journey with ordinary signup, saved-draft and chosen
version copies, three independent publications/runs, nested For Each and
Parallel/Merge, dynamic expression outputs isolated by run, and copy-only edits.
It verifies two atomic receipts/audits and normal fixture teardown. The full
repository check and 90 browser journeys pass; all 821 PostgreSQL integration
tests across 109 files pass without skips. Coverage binds 24 cohorts to the frozen
source and records zero unreviewed risk branches. Final reviewed `a766f585`
adds safe uncertain/stale/accepted-result recovery; its 849 web tests, 90 browser
journeys and 24 source-bound coverage cohorts pass with zero unreviewed risk
branches. The manager independently reran 26 focused duplication tests. Earlier
service-backed local results remain bound to `06ca64c1`; hosted qualification
of the repaired head and natural main is recorded separately above.
Only the same-workspace Duplicate first slice has completed hosted release.
Import/export is implemented under ADR062 and independently reviewed at
`ba997c39`; its broad local evidence remains bound to `5ada95ea`, with later
frontend repair evidence recorded separately in the F05 plan. Templates and
cross-workspace copy are outside this released slice. No production effect is
authorized. F12, F29 and F30 remain qualified; their completed work is not reopened.

The combined F02/F05 integration is recorded as normal merge commit
`780a1542bb6d0a69a4747b6728e464e3bae61af4`, with parents `ba997c39` and
`085fa974` and qualified tree `af76b53ea6f62356c2ea6246e5c2f85ff314485d`.
Both integration review axes retained the feature registrations, contracts,
UI/CI gates and ordered 0130/0131/0132 history with exact head 0132.

- [x] Qualify 104 feature/authority cases and 56 migration/readiness/RLS cases
      on the exact combined tree, with strict validators and zero skips.
- [x] Verify owned PostgreSQL/Redis fixture cleanup and unchanged other services.
- [x] Qualify the combined reviewed commit through hosted CI, authorized merge
      and inspected natural-main checks.

The source-bound receipt is preserved at
`/Users/vigan/.codex/evidence/pertexo-f05-2026-10-02/combined-migrations/qualification-receipt.md`.
The 31 run-API tests are included in the 104 cohort, so distinct final-tree
coverage is 160 tests. Another 25 ordinary-authoring tests passed on the earlier
resolved tree; only two expected-head test strings changed afterward, and those
results are carried forward rather than relabeled as reruns. Initial stale-head
failures and two unchanged five-second duplication-upgrade timeouts remain
retained. The unchanged isolated test and full 56-case cohort subsequently
passed; resource contention is supported but not conclusively established, and
freedom from timing flakes is not claimed. Both new writer gates remain off;
serving and restore images must qualify against their exact migration head.

Release owner completed all 14 hosted checks on exact PR145 head
`152510845202dd370e46f9069c1a6b1fe7f053f1`, including the responsive action wrapping
and scoped portability-authority repairs. Human-authorized squash merge produced
actual main `c8a59b0912de97866e3868906c749ae9240fba0a`, tree
`48b71dbd95b294a303dd1370e214b944a06cc1a6`, identical to that reviewed head.
[Natural-main CI](https://github.com/vigani1/pertexo/actions/runs/36949789113) and
[CodeQL](https://github.com/vigani1/pertexo/actions/runs/36949789141) pass: all 11
applicable CI jobs, all six strict real-browser gates, real integration, mutation,
required-cohort validation and fixture cleanup. PR-only dependency review is
not applicable to the natural push. No monitoring/wait remains in that release lane.
Final exact-source receipts are retained in
`/Users/vigan/.codex/evidence/pertexo-f05-2026-10-02/live-portability-import-red/receipt.md`
and the combined qualification directory above. Historical 160-case evidence stays
bound to `af76b53e`; it is not relabeled as a rerun at `f5432838`, `15251084` or main.
This completes the accepted F02/F05 first-slice release, not their broader roadmap
or production activation. F06 retains its reviewed `f5432838` implementation base
and migration 0133 reservation; its additive merge `35182e7` integrates the two
reviewed UI descendants without rewriting history or altering this release proof.

### F30 — connection health first slice

The manager accepted [ADR059](./adr/059-connection-health-observations.md) and
the [F30 plan](./feature-plans/30-connection-health.md) on 2026-10-01, based on
reviewed F29 head `7561e822`. The narrow slice is independently reviewed and
merged through PR139 and test-only follow-up PR140. Final natural main
`adaa26df5f31ad4bbf69429f091f77acc707bf70` passed CI and CodeQL.
Scope is Slack run-derived evidence,
version/revision-fenced durable application, safe manual recovery, authorized
published-version usage, and the existing connections/settings UI. Notices and
other automatic providers are deferred; production activation is not authorized.

- [x] Reconcile baseline and record signal, ordering, recovery and usage choices.
- [x] Accept ADR059 and the manager-owned implementation/acceptance plan.
- [x] Implement contracts, capability security and durable backend with focused
      real PostgreSQL proof.
- [x] Implement the frontend and real API/worker/browser behavior.
- [x] Pass frozen-source local qualification, including full PostgreSQL and
      enabled HTTP/browser evidence.
- [x] Repair the reviewed ordinary-command conflict eviction and prove real
      abandoned publication ownership recovery after natural lease expiry.
- [x] Complete independent reviews; merge a scoped green PR and inspect natural
      postmerge checks.

Focused evidence: 23 run-health PostgreSQL cases, 16 boundary cases and two
bounded usage cases pass. The boundary executes legal-hold/release, retention
cascade/command cleanup, late delivery and actual tenant purge, plus exact 0127
upgrade and ACL/readiness drift. Notification acceptance's bounded lock-and-read
capability preserves the current secret after concurrent rotation; omitted or
cross-workspace context yields no rows, and body/execute-grant drift fails
startup. Interrupted publish, durable publish-mark
failure and health-application rollback preserve accepted run/attempt snapshots.
The real controlled-Slack HTTP and browser fixtures each pass one enabled case
with zero skips; provider calls do not increase across the acknowledged
worker-runtime restart. The repaired HTTP proof additionally abandons a real
dispatcher owner's durable health-publication claim before returning the event:
no publish, acknowledgment or release occurs. The token remains unexpired across
runtime recreation, then the unchanged 30-second lease expires naturally before
publication/application. Exactly one completed receipt and transition result;
the accepted run/attempt snapshots and one provider call remain unchanged. This
is not an OS process-kill claim. The same-hook user/workspace-switch command race
and held replacement ordinary/idempotency 409s are covered; 822 web tests pass.
Conflicts preserve the typed credential, retained command, retry key and feedback;
actual access loss still clears scoped caches. All 89 web browser cases pass.
Deployment contracts (61 cases), browser-safety probes (seven cases) and the
non-artifact API service cohort (86 cases, zero skips) pass. Frozen-source full
PostgreSQL integration with coverage passes 107 files / 795 cases with zero skips;
the final-built HTTP and browser cases also pass. Final `pnpm check` and
`pnpm test:coverage` pass: 24 source-bound cohorts, zero unreviewed risk branches
and 388 reviewed residual branches across 211 selected files. Four reachable
arms gained tests; two now-covered reviews were removed and one unchanged
defensive fingerprint was refreshed, with no threshold/exclusion relaxation.
Implementation commit `e5a44165` is integrated with qualified main `02750811`
through normal merge `f03191d3`, without rewriting history. The merge tree is
identical to the qualified implementation tree; CI routing, schema ownership,
documentation and coverage provenance passed again. Source fingerprint:
`sha256:b3586f5eee9b970ba85b7e2e120b37d708812ba109747c65e32397dcee1dd276`.
The owned `pertexo-connection-health-20261001` PostgreSQL/Redis containers,
network and two volumes were removed after all database clients closed and
fixture Redis DB13 was empty. Evidence remains outside the checkout under
`/Users/vigan/.codex/evidence/pertexo-f30-2026-10-01/`. At that local qualification
point, no push had been performed; 43 unrelated primary-checkout changes were
preserved. Review repairs are
`ef5c955d` (command conflicts) and `72a32b2f` (abandoned ownership proof).
Fresh repair evidence is retained in the receipt's `repair/` directory; the
original qualification receipt remains historical. The isolated
`pertexo-connection-health-repair-20261001` project was also removed after zero
clients, disposable databases and Redis DB13 keys/ownership were verified.
Production lease budgets, coverage thresholds and CI owners remain unchanged;
only the HTTP proof's bounded test ceiling accommodates actual lease expiry.
Production mode remains `off`; no provider traffic outside owned fixtures is
authorized.

[PR139](https://github.com/vigani1/pertexo/pull/139)'s earlier
`06917f74` CI recovery and integration lanes exposed the same older HTTP-worker
fixture reset failure after a legitimate email credential rotation: restoration
omitted the revision-aware protocol. Repair `7abbc106` changes test fixtures only,
advances revision and clears current-credential health on version restoration,
and leaves revoked rows unchanged. A separate connection regression proves
restoration is idempotent and cannot roll back a revoked current version. The
same four recovery files pass 22 cases; full enabled worker integration passes
22 files / 47 cases, both strict zero-skip. Worker units (903 cases), full build,
worker lint/typecheck, complexity, duplication and CI routing pass. Production
source and its qualified coverage fingerprint are unchanged. The downstream
API integration cohort passes 21 files / 109 cases with the unchanged CI
exclusions; API SSE reconstruction and worker transport service-loss recovery
each pass one enabled case. All reports pass strict zero-skip validation.
Owned fixture services/data were removed after zero-client/database/proof-key
checks. These local results are historical and recorded in the CI-repair receipt.

Independent feature specification and standards reviews accepted the
implementation and repairs. PR139 merged reviewed head
`94509ee87171f1b06777aa692f7409edf675efca` as
`4ad9f8afe7a82184e2356345eaeed3492688dfe5` after exact-head
[CI](https://github.com/vigani1/pertexo/actions/runs/36830092069) and
[CodeQL](https://github.com/vigani1/pertexo/actions/runs/36830092139) passed.
Its [first natural-main run](https://github.com/vigani1/pertexo/actions/runs/36831587356)
failed one statistics plan assertion. A retained
pre-insert snapshot reproduced the bitmap-scan symptom and showed that a
successful VACUUM alone did not establish all-visible fixture pages. Test-only
[PR140](https://github.com/vigani1/pertexo/pull/140) added bounded snapshot
readiness, explicit visibility assertions, a regression and diagnostic plan
output without changing queries, planner settings or performance budgets.
The original failed CI run captured no snapshot/plan state, so its precise
cause remains unconfirmed. No unchanged failed run was retried for qualification.
Local repair evidence passes 796 database integration tests, all 20 statistics
cases and 891 database unit tests; both independent repair reviews found zero
findings.

PR140 merged reviewed head `0b22c49448d314ee9917dad6094cd7c771f5e9a8` after
exact-head [CI](https://github.com/vigani1/pertexo/actions/runs/36835574309) and
[CodeQL](https://github.com/vigani1/pertexo/actions/runs/36835574239) passed.
Final natural main `adaa26df5f31ad4bbf69429f091f77acc707bf70` passed
[CI](https://github.com/vigani1/pertexo/actions/runs/36837670529) and
[CodeQL](https://github.com/vigani1/pertexo/actions/runs/36837670516).
All applicable lanes passed, including integration, recovery, browser, coverage,
production image, compatibility and deployment security; dependency review was
appropriately skipped on main and passed on the PR. Final qualification and
the indexed local evidence are recorded in
`/Users/vigan/.codex/evidence/pertexo-f30-2026-10-01/final-receipt.md`.
Owned disposable services were removed; unrelated primary-checkout work and
everyday services were preserved. `CONNECTION_RUN_HEALTH_MODE` remains `off`.
This closes only F30's planned narrow Slack slice, not production activation or
any other phase.

### F29 — queue-only workflow concurrency

The ADR058 queue-only first slice is qualified. Independent specification and
standards reviews closed the correctness and CI-ownership findings; final
rereviews reported no remaining findings. [PR138](https://github.com/vigani1/pertexo/pull/138)
merged reviewed head `7561e822` as `02750811c0bbb8545042f96f9f6f53784c9ff5d2`
on 2026-10-01. Required exact-head checks and natural postmerge CI/CodeQL passed.
This does not close Phase 7 or supersede the
historical qualification fingerprints below. F12 PR137 is merged as `23cc5b45`;
the release owner has confirmed natural main CI and CodeQL success on that
commit, closing the first read-only capacity/activity slice's qualification.
This satisfies the F12 dependency independently of F29's completed qualification.

- [x] Current workflow cap, durable acceptance tickets, workspace-authoritative
      admission, ordered starts, and grandfathered reservations implemented.
- [x] Authorized CAS/idempotent settings commands and timestamped queued-run
      blockers implemented with settings/history UI.
- [x] Real PostgreSQL proof: 22 concurrency cases plus 18 existing regression
      cases; 878 database unit tests. Coverage includes reverse starts, shared
      workspace capacity, settings/acceptance races, control-path delivery,
      legacy upgrade, role boundaries, and readiness drift rejection.
- [x] Repaired full PostgreSQL suite: 104 files / 753 tests passed. The privileged
      trigger-disabled terminal-history seed allocates mandatory tickets
      explicitly; its normal-planner budgets remain unchanged.
- [x] Real HTTP proof: three authorization, command, replay, and policy cases.
- [x] Repaired enabled non-artifact API service cohort: 19 files / 86 tests
      passed, zero skips under strict JSON validation. Artifact-transfer,
      compatibility rollout and the editor/Usage/concurrency browser files were
      explicitly excluded; F29's live browser proof below ran separately.
- [x] Real API/worker/browser proof: cap 1 leaves the second run queued with no
      node execution; an acknowledged worker-runtime restart preserves state;
      browser removal releases the second run with ordered start timestamps.
- [x] Repaired head `9bda9ee8` passed `pnpm check`: full build, typecheck, lint,
      contracts, architecture, complexity, duplication and unit suites passed
      (API 1,790, worker 868, database 878, web 798 tests).
      Changed React Doctor score: 100/100.
- [x] Repaired tree passed `pnpm test:coverage`: 24 cohorts bound to source
      fingerprint
      `sha256:7d10d5483a39527bae8ca485fb738fad60461e6c18ad1cae80eb22cb9fe64a44`;
      zero unreviewed / 390 reviewed residual branches across 210 selected
      files and 8,075 coverable lines. No review, exclusion or budget changed
      during the repair qualification. The pre-review witness was
      `sha256:198aa04d84d05ffc8c94893acc070ff10e50930640ab59d7b546829c04a82581`.
- [x] `pnpm test:browser-probes` (seven assertions) and
      `pnpm deployment:check` (60 assertions) passed locally.
- [x] Lock order, mixed-version fail-closed enforcement, and rollback documented
      in [the enforcement note](./operations/workflow-concurrency-enforcement.md).
- [x] Independent manager review and complete first-slice release qualification.
- [x] Close the reviewed active-insert serialization race, preserve committed
      reservations during FIFO deferral, and cancel stale reads before
      denied-write cache eviction; focused RED/GREEN proofs recorded below.
- [x] Requalify the repaired tree locally with repository checks, coverage,
      full PostgreSQL, real HTTP/browser, browser probes and deployment checks.
- [x] Complete independent rereview of the repaired implementation.
- [x] Scoped PR merged with required checks; natural postmerge result inspected.

The PostgreSQL receipt proof exercises bounded maintenance reaping and verifies
both new tables in the authoritative tenant purge function; it does not claim
an executed tenant-row purge. The live restart is a worker-runtime lifetime
restart, not an operating-system process kill. Skip overflow and independent
queue configuration remain deferred. No production deployment or activation
was performed.

Implementation commits: `c02f0ce4` (database/contracts/API) and `36392cdb`
(settings/history UI and integrated proof). Normal merge `a3f0af4c` incorporates
the manager-reviewed F12 qualification repairs; it is not a release or postmerge
main qualification claim.

The CI-routing follow-up normally merged F12's reviewed browser-owner fix
`80621acb` in `f1b4cb4`, then gives the concurrency fixture its own required
browser-installed CI step and ordinary/local cohort exclusion. Local execution
with the CI environment and an attested task-owned Compose project passed
one live test; the unchanged strict JSON validator accepted it with zero skips.
Ownership unit tests cover 45 accepted and rejected configurations. CI routing
and local-quality contracts pass; this is not a hosted CI completion claim and
does not change the manager's fixed-point core implementation review.
The exact task-owned Compose CI proof project was retained through repair
verification, then removed with its two disposable volumes after checking zero
fixture databases, zero base clients and empty Redis DB11. Its browser/worker
lifetimes had closed. No everyday service was adopted.

The review fixes were reproduced before implementation. Eight real PostgreSQL
API/worker × running/waiting × marked/unmarked INSERT races observed the writer
blocked by the authenticated settings transaction, then incorrectly committed
after the cap. The post-counter policy check now rejects all eight with the
expected `PTC01`/`PTC02`. A real coordinator-store test reproduced B's lost slot
when cap 2 reservations were lowered to 1 and B arrived before A. The repaired
path preserves and rebinds B's reservation through deferral, duplicate delivery
and store restart; A then B start using their committed slots, without a third
grant. Twelve new regressions (the nine original failures plus worker/context,
binding and real-recovery boundaries), the existing 22 concurrency cases and
19 coordinator scheduling cases pass: 51 assertions. Readiness mutation tests
reject helper body and execution-ACL drift for API, worker and dispatcher.

Frontend commit `2a8d89f0` cancels the exact protected settings read before cache
eviction. All 21 settings tests pass, including held GET + denied PUT
401/403/404 with real HTTP and cancellation-ignoring reads, remount/network
failure and fresh authorized recovery; changed React Doctor remains 100/100.
The new reservation helper is worker-only and readiness pins its body and exact
ACL; the trigger fingerprint now includes its serialized second policy check.

Database repair commit `9bda9ee8` passed the full PostgreSQL suite and repository
checks. The repaired real HTTP proof passed 3/3 and the CI-environment live
API/worker/browser proof passed 1/1, both with zero skips under strict JSON
validation. Normal merge `7953fd6a` incorporates PR137's main merge `23cc5b45`;
the merged tree is exactly identical to its first parent `9bda9ee8`. Conflicts
retained the already-merged F12 behavior and reviewed F29 migration/CI additions;
one automatic duplicate type import was removed. CI gate tests and API typecheck
also passed after resolution. The subsequent manager receipt confirms natural
main CI `36806860550` and CodeQL `36806860572` both concluded `SUCCESS` on
`23cc5b45`; see the [F12 evidence log](./feature-plans/12-usage-and-insights.md#delivery-tracker).
These hosted F12 results are not inferred from local qualification and do not
establish F29 hosted CI or release approval. F12 warnings/trends remain deferred.

Final repair qualification passed `pnpm test:coverage` (24 source-bound cohorts,
zero unreviewed residual branches), seven browser probes and 60 deployment
assertions. The enabled non-artifact API cohort passed all 86 cases after the
normal migration bootstrap of this task's previously empty owned base database.
The earlier broader API attempt failed on missing `app.auth_identities`; this
was a local setup omission, not masked by exclusions or test changes. Likewise,
an unchanged benchmark SIGINT process-startup timeout passed in isolation and
in the full `pnpm check` rerun with its original deadline. Generated JSON reports
were preserved outside the checkout, not committed. Required independent
rereview and F29 release/PR checks subsequently closed by the release-owner
receipt below; F12 natural main qualification is independently complete.

Heavy qualification suites were serialized after concurrent runs hit unchanged
workflow-engine and coordinator-observation test timeouts. Isolated observation
tests and the final full database suite passed with their original budgets;
no production code, timeout, or gate was changed to hide those failures.

Both the original and follow-up task-owned PostgreSQL/Redis projects were removed
after qualification;
their disposable fixture data was discarded. Everyday services and the 43
uncommitted paths in the primary checkout were left untouched. The F29 branch
was subsequently pushed and tracks `origin/feat/workflow-concurrency`.

The release owner's 2026-10-01 receipt confirms exact-head
[CI36810146630](https://github.com/vigani1/pertexo/actions/runs/36810146630) and
[CodeQL36810146584](https://github.com/vigani1/pertexo/actions/runs/36810146584)
passed before PR138 merged. Natural main
[CI36811514908](https://github.com/vigani1/pertexo/actions/runs/36811514908) and
[CodeQL36811514931](https://github.com/vigani1/pertexo/actions/runs/36811514931)
both succeeded on exact merge head `02750811c0bbb8545042f96f9f6f53784c9ff5d2`.
The main-push dependency-review skip is expected; applicable quality,
integration, browser, coverage, recovery, compatibility, deployment-security
and production-image checks passed. Queue-only qualification is complete;
skip overflow remains deferred and Phase 7 remains open. No production
deployment or activation is claimed.

### Historical backend qualification

The backend fixes are recorded in commit `f0484564`. The final SSE
public-projection correction keeps the original validation error, starts the
transport cleanup budget before awaiting an uncooperative nested iterator, and
observes late fulfillment/rejection without leaking resources. The full API
run passed 97 files / 1,277 tests.

The pre-cleanup full local qualification,
`pertexo-local-quality-2026-09-14t09-35-41-831z-24290-031bb08c`, passed all 21
required cohorts at full-run candidate fingerprint
`sha256:37fb33395ed496f5fbfb5dda82ac221c03bbc54b802155569a37ae6079d28743`.
Its app/package source inventory fingerprint is
`sha256:b460ce440131ff15831907d051f0b062f7f1e943ad538925a4c2bd6872c7d01c`.
The source inventory accounts for 691 files, and risk evidence records 405
reviewed / 0 unreviewed branches across 186 selected files and 7,500
coverable lines. This fingerprint and evidence describe the pre-cleanup
candidate only; they are not a claim about the post-move source tree. Local
service evidence contains 665 assertions. The only
exclusions are the three declared AWS-only control-ledger cases. This remains
local qualification; that run did not perform hosted CI, deployment, provider
requests, or AWS operations.

The subsequent documentation and infrastructure organization passes
`pnpm prepush:check`, `pnpm deployment:check`, `pnpm images:check`, and
`pnpm exercise:check`. The new documentation checks retain link and current
operational-policy validation without requiring retired audit records.
Fresh coverage binds all 24 producer cohorts to app/package source fingerprint
`sha256:52bccd43d4b33466f1d2228a9a4edb663eae9ca0fdceebc65610ecc6fd07e9cd`.
`pnpm coverage:evidence` regenerated the [source inventory](./remaining-work/source-inventory.json)
and [risk snapshot](./remaining-work/risk-snapshot.json): 691 sources, zero
unmapped runtime files, and 405 reviewed / zero unreviewed residual branches.
Source-to-test mapping is not execution coverage. These checks verify the
cleanup; the service-backed qualification above remains explicitly pre-cleanup.

## Status summary

| Checkpoint | Status | Evidence retained |
| --- | --- | --- |
| Phase 0A — repository and process skeleton | Complete | ADR 001; API/worker bootstrap and lifecycle checks; `pnpm check` |
| Phase 0B — PostgreSQL tenancy and RLS proof | Complete | ADR 003; clean PostgreSQL migration and RLS integration matrix |
| Phase 0C — HTTP and observability foundation | Complete | Compiled API/worker role, health, and telemetry smoke checks |
| Phase 0D — queue, outbox, and duplicate-delivery proof | Complete | ADRs 005–006; unit, real-service, and recovery assertions |
| Phase 0E — execution durability and engine gate | Complete | ADRs 005, 007–009; engine, process-recovery, SSE-outage, and transport-outage proofs |
| Phase 1 — identity/workspace vertical slice | Complete | ADR 004; generated-contract drift and real-service identity/RLS evidence |
| Phase 2 — workflow authoring vertical slice | Complete | ADRs 002/011; draft, publication, lifecycle, and version-restore evidence |
| Phase 3 — first executable-node slice | Complete | ADR 010; compatibility, execution, rollout, and recovery evidence |
| Phase 4 — first side-effecting integration slice | Complete | ADRs 007/016; PostgreSQL/outbox/BullMQ retry-wakeup and recovery evidence |
| Phase 5 — orchestration slice | Complete | ADRs 008, 017–022; branching, parallelism, retry/wait, notification, and recovery matrix |
| Phase 6 — V1 providers and triggers | Complete | ADRs 012–014, 023–026; provider, webhook, schedule, retained-history, and rollout evidence |
| Phase 7 — production operations | **In progress** | Repository implementation is qualified locally; external deployment, provider, load, recovery, telemetry, and pager evidence remains open |
| F02 — run-input cases / checked manual start | First slice released; broader roadmap open | ADR061 first slice, combined PR145 and exact natural main `c8a59b09` CI/CodeQL pass; historical 160-case database receipt remains source-bound; broader F02 and production activation deferred |
| F05 — portable workflow authoring | First slice released; broader roadmap open | ADR062 import/export, combined PR145 and exact natural main `c8a59b09` CI/CodeQL pass; historical/local repair evidence retained separately; broader F05 and production activation deferred |
| F29 — queue-only workflow concurrency | Qualified | ADR058 queue-only slice, independent reviews, PR138 exact-head and natural main CI/CodeQL; skip overflow deferred |
| F30 — first Slack connection-health slice | Qualified | ADR059 narrow Slack slice; independent reviews, PR139/140 exact-head checks and natural main CI/CodeQL on `adaa26df`; production mode off |

The 0A–0E rows subdivide the plan's single Phase 0 and do not change its
authoritative scope. All accepted architecture decisions remain under
[`adr/`](./adr/); their presence governs implementation but does not close
production gates.

## Phase 7 — Production operations

Status: **In progress**

### Authority and production policy

- [x] ADR 013 governs destructive retention, workspace purge, legal hold, and
      backup-erasure behavior.
- [x] ADR 015 fixes the initial SLO, hosting regions, backup, failover,
      recovery, RPO, and RTO strategy.
- [x] Operated legal authority, backup rotation, minimization, and retention
      policy inputs are recorded without claiming legal certification.
- [x] ADR 027 governs asynchronous tenant-facing deletion and restore dispatch.

### Retention, deletion, and legal hold

- [x] Dedicated maintenance credentials and migration-role substitution are
      bounded and do not grant serving-role access.
- [x] External control-ledger adapters, ordered PostgreSQL projection,
      high-water reconciliation, and restore-before-serve are implemented.
- [ ] Prove the dual-region append-only ledger and restore-before-serve gate
      against production AWS accounts, regions, IAM roles, and Object Lock.
- [x] Legal-hold placement/release, bounded resumable retention, leases,
      fencing, dry-run support, and dependency-safe 30/90/365-day retention are
      implemented.
- [x] Workspace deletion/restore revokes access and triggers, cancels work,
      preserves the recovery window, and records retryable purge progress and a
      non-sensitive completion tombstone.
- [ ] Prove deletion, legal hold, recovery-window, purge, and regional object
      behavior through production deployment and immutable invocation evidence.

### Operator recovery and observability

- [x] Authenticated, authorized, audited, reason-required operator commands
      cover outbox redispatch, lease reconciliation, due-work resume,
      unknown-outcome evidence, cancellation, replay, trigger reconciliation,
      and retention/purge reruns.
- [x] Cardinality-safe metrics and repository-owned dashboards/alerts cover
      API, PostgreSQL, queues, workers, triggers, providers, artifacts,
      retention, purge, and the control ledger.
- [ ] Deploy dashboards and alerts and capture pager-routing/response evidence.
- [x] Non-root, read-only, digest-pinned image/task contracts, separate
      commands and health checks, release-job migrations, and secret-manager
      references are validated locally.
- [ ] Prove rendered image, task-role, filesystem, migration-job, health, and
      secret-manager boundaries in the production deployment.
- [x] Separate API/worker autoscaling inputs are declared against admitted
      load, latency/saturation, oldest-job age, active slots, and resource
      safety.
- [ ] Deploy and measure autoscaling under representative load and saturation.

### Release exercises and completion gates

- [x] The source-stable local quality checkpoint passes coverage, mutation,
      performance, integration, deployment-rendering, recovery, and cleanup
      gates, with explicit AWS exclusions.
- [ ] Run webhook bursts, large fan-out, long-wait, and noisy-tenant load tests
      and prove fair admission under saturation.
- [ ] Run Redis-loss, PostgreSQL-failover, provider-outage, worker-drain, and
      object-storage failure exercises without contradictory durable truth.
- [ ] Run backup/PITR and regional restore drills, reconcile the control ledger
      before traffic, and measure five-minute RPO / 24-hour RTO.
- [x] Root checks, dependency/security scans, migration checks, real-service /
      recovery matrices, and production-build verification pass locally.
- [x] Fixed-head review blockers and high findings are resolved through the
      implementation checkpoint; this does not close external gates.

### Current Phase 7 evidence and open obligations

The local qualification above is paired with the active operational contracts:
[external platform](./operations/external-platform-contract.md), [local
quality](./operations/local-quality-verification.md), [regional recovery](./operations/regional-recovery.md),
[database function readiness](./operations/database-function-readiness.md),
[release/security gate](./operations/release-security-gate.md), [observability
alerts](./operations/observability-alerts.md), and [production data policy](./operations/production-data-policy.md).
These documents define owners, bounds, evidence schemas, cleanup, and explicit
limits; they do not assert deployment.

The remaining named external evidence families are:

- **ART-002:** production artifact latency and capacity observations.
- **ART-008:** live AWS dual-region artifact and recovery qualification.
- **DB-011:** representative PostgreSQL workload, planner/cache, lock/WAL,
  vacuum, and index-usage evidence at expected and burst cardinality.
- **DB-017:** deployed backup/PITR, restore, pooler, failover, RPO/RTO,
  autovacuum, replica-admission, and capacity evidence.
- **INT-010:** protected Slack, Resend, and AWS KMS sandbox compatibility.
- **INT-013:** production-like DNS/connect/TLS concurrency and latency before
  changing the safe no-pooling policy.
- **OBS-006:** production telemetry retrieval and alert/pager proof.
- **RL-002:** deployed non-clustered replicated Redis topology compatible with
  the atomic multi-key rate-limit policy.

The separately authorized Q14/E01 evidence packet covers deployment, storage,
security, provider, load, failure, pager, migration/PITR, regional recovery,
deletion, restore, and purge drills. Every drill requires identity, access,
command, capability, result, and cleanup fields. A completed packet is not
execution evidence; production accounts and deployed infrastructure are still
required. API-key and connected-subscription entities remain deferred by the
V1 scope and must not be invented solely to satisfy deletion coverage.

## Requirement-to-evidence navigation

| Plan area | Canonical owners | High-value proof |
| --- | --- | --- |
| Foundation and process roles | `apps/api/src/main.ts`, `apps/worker/src/main.ts` | API bootstrap and worker lifecycle tests |
| Identity, tenancy, and security | `apps/api/src/identity-workspace/`, `packages/database/src/tenant-access/` | Real identity HTTP and RLS integration tests |
| Authoring and publication | `apps/api/src/workflow-authoring/`, `packages/database/src/authoring/` | Lifecycle and version-restore integration tests |
| Execution, queues, and recovery | `packages/workflow-engine/`, `packages/database/src/execution/`, worker coordinator | Parallel assurance and redelivery/recovery tests |
| Integrations and connections | `packages/integrations/`, API connections | HTTP executor and connection integration tests |
| Providers and triggers | API webhooks, worker triggers, database trigger stores | Direct webhook and schedule recurrence integration tests |
| Artifacts and capacity | `packages/artifact-store/`, database artifact authority, API artifact controller | Dual-region store and artifact transfer tests |
| Operations and recovery | retention/recovery apps, database lifecycle, `infrastructure/ecs/` | Retention inventory and restore-before-serve tests; external evidence remains open |

These routes locate responsibility; they are not independent completion claims.

## API discovery gap closure

The four previously unallocated read surfaces are implemented and verified
locally: `GET /v1/users/me`, workspace member listing with opaque keyset
pagination, `GET /v1/node-definitions`, and `GET /v1/integrations`. They use
existing authentication/rate limits, bounded public projections, authorization,
RLS, generated contracts, and deterministic catalog selection. They do not add
profile administration, invitations, membership mutation, connection
credentials, or a second connection resource. Later identity slices add role
changes and removal (ADR 037, ADR 042), invitations (ADR 038), the
signed-in person's own display-name change (ADR 043), and leaving,
suspension, reactivation and ownership transfer (ADR 047).

## Weft follow-up reads

Post-plan read surfaces close gaps the Weft frontend recorded, each behind its
own ADR and implemented through contracts, database, API, integrations and
web:

| Surface | Route, authority and rate class | Decision and storage |
| --- | --- | --- |
| Webhook delivery log | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/deliveries`; `workflow:read` guard plus the owner/admin/builder trigger-read check; `authenticated_read` | [ADR 045](./adr/045-webhook-delivery-log.md). Migration `0115_webhook_delivery_log.sql` adds outcome, HTTP status, signature and replay checks and body size to `app.webhook_trigger_deliveries`. Post-allowance rejections are recorded best effort in their own transaction; the 90-day retention class, RLS and purge are unchanged, and expired rows are never served. |
| Slack channel names | `GET /v1/workspaces/:workspaceId/connections/:connectionId/slack/channels?channelIds=…`; `connection:use` guard and database check; `provider_test` | [ADR 046](./adr/046-slack-channel-name-resolution.md), extending ADR 023. Up to ten IDs per request resolve through `conversations.info` with the connection's bot token under the `connection.credential_accessed` audit fact; names are never stored and unresolved channels return a reason instead of an error. No migration. |
| Schedule run history | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/occurrences`; `workflow:read` guard plus the active-member schedule-read check; `authenticated_read` | [ADR 048](./adr/048-schedule-fire-history-and-next-runs.md). Pages the occurrences the scanner already records (`accepted` with its run, or `skipped`), newest first, with a trigger-bound cursor; occurrences past the 90-day trigger-summary cutoff are never served. Throttled or failed claims stay trigger health. No migration: the existing occurrence index serves the keyset. |
| Schedule next runs and draft preview | `GET …/triggers/:triggerId/schedule/next-runs?count=` (`authenticated_read`) and `POST …/triggers/schedules/preview` (`workflow_compile`, CSRF); same authority | [ADR 048](./adr/048-schedule-fire-history-and-next-runs.md) on ADR 014. The persisted next fire, then the instants the scanner would persist, 1–10 (default 3), from the scheduler's own engine, timezone and DST rules and database time. The preview checks an unsaved Schedule step setup with the scheduler's parser and runs in a read-only transaction. The engine caches one `Intl.DateTimeFormat` per canonical timezone. |
| Run data | `GET /v1/workspaces/:workspaceId/runs/:runId/input` and `GET …/runs/:runId/node-runs/:nodeRunId/output`; `run:read` guard; `authenticated_read` | [ADR 050](./adr/050-run-data-reads.md). Returns a run's stored input or one node run's stored output (inline JSON, an artifact reference, `none`, or an input `expired` past its 30-day window) from a workspace-scoped read transaction. Run summaries add `replaySourceRunId`; list items add `failedStep`, named from the run's version graph (nested loop steps included) by one bounded extra query for the page's unsuccessful runs. No migration. The web run page shows each step's Data in and Data out, the run's input with Replay starting from it, and the replay source; run lists say where a run failed. |
| Step history and health | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/step-health` and `GET …/workflows/:workflowId/steps/:nodeId/runs?limit=`; `run:read` guard; `authenticated_read` | [ADR 051](./adr/051-step-history-and-health.md). Both read the workflow's newest 100 runs through the existing workflow and node-run indexes: per step, how often it ran, succeeded, failed or was skipped, its latest status and the median and 95th percentile duration of its successful runs; and one step's latest runs with the run each belongs to. No migration. The editor's step panel gains a Runs tab (health, last result, recent runs) and workflow settings a Steps section ordered by failure rate. |
| Recorded step inputs | `GET /v1/workspaces/:workspaceId/runs/:runId/node-runs/:nodeRunId/input`; `run:read` guard; `authenticated_read` | [ADR 052](./adr/052-record-step-inputs.md). Before its executor runs, each attempt of a step that doesn't use a connection records its resolved input on `app.node_runs.input_ref` under the attempt's lease and fence, best effort and inline only (256 KiB). Admitting a retry clears its predecessor's input, so none passes for another attempt's; a resumed wait keeps its step's. Migration `0119` grants the worker `UPDATE (input_ref)`, and the readiness probe requires it. Steps that ran before read `none`. The run page's Data in shows the recorded input, with where it came from underneath, and otherwise says why there is none and labels the source data as such. |

Evidence: database integration tests on disposable databases
(`webhook-triggers`, `webhook-trigger-prior-head`, `connection-lookup`,
`schedule-trigger-reads`, `workflow-run-api`), DST-boundary projection tests
(`schedule-fire-projection`), the
direct-webhook HTTP integration test, API unit and coverage suites (the delivery
recorder joins the priority cohort and the channel lookup the orchestration
cohort), the API bootstrap HTTP test for the schedule routes, the Slack client
tested against a mocked HTTP boundary, regenerated webhook, connection and
schedule OpenAPI artifacts, and web component and hook tests. Recorded step
inputs are covered by `coordinator-run-store-node-attempts` (recorded under a
live lease, nothing once it is lost) and `workflow-run-api` (read back, `none`
before recording), and were checked against a local stack, where a scheduled
run's steps each recorded what their executor received. Live Slack
workspaces and deployed traffic were not exercised.

## Update protocol

When a checkpoint changes status:

1. Update its checklist and the summary table together.
2. Record concrete ADRs, commits, commands, tests, measured results, or drills.
3. Leave incomplete and deferred requirements unchecked with their blocker.
4. Never mark complete from generated files, unit tests, or prose alone.
5. Re-run the documentation and relevant implementation gates after structural
   changes before treating this tracker as release evidence.

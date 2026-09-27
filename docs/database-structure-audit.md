# Database responsibility and redundancy audit

Date: 2026-09-27. Baseline: `9e39c8d0` plus the existing dirty working tree.
Status: **local correction verified; external/replay proof limits remain.**
N1–N4 received independent local review; DB-01–13 and every package-wide
matrix family have a disposition and concrete evidence below. The remaining
limits are named at the end of the matrix; local green tests are not a claim
of provider or production verification.

## Purpose and sequencing

Review the whole database package for misplaced decisions, duplicated rules,
inconsistent contracts, shallow interfaces, and unnecessary indirection. This
is not a proposal to replace the architecture or make the package smaller at
the expense of correctness.

The reviewer owns this report and verification. The existing implementation
chat, **Review apps web codebase** (`01a0a09e-2fed-7061-99c2-e1a5412561e7`), owns
fixes. First finish and verify N1–N4 in `docs/node-execution-audit.md`; do not
merge these cleanup changes into that unfinished batch. Then work through the
findings below in bounded slices. The user retains final review of the diff.
No commit, push, merge, production deployment, external provider call, shared
service shutdown, or destructive data reset is authorized.

## Verdict

The foundation is sound: grouped public exports, tenant-scoped transactions,
shared pool ownership, durable receipts, fenced writes and atomic outbox writes
provide real leverage. Nevertheless, this review found concrete contract drift
and duplicated lifecycle decisions, not merely cosmetic concerns.

Use these ownership rules:

- The workflow model/engine owns graph meaning, control-node semantics and
  scheduling decisions.
- Persistence validates what it accepts and reads, checks authoritative locked
  state, and commits the decision with its receipt/events/outbox atomically.
- Small shared primitives own genuinely identical encodings and resource
  lifetime mechanics; domain-specific policy remains explicit.
- A second validation at a trust seam is necessary. A second independently
  maintained definition of the same contract is a drift risk.

## Findings and required acceptance evidence

The numbered findings are not the complete definition of clean code. Close the
pattern-family review below as well: adding a helper while leaving equivalent
rules scattered elsewhere does not close a finding. Conversely, syntactically
similar operations with different security or replay contracts must not be
forced into the same implementation.

References are source locations at review time; symbols are authoritative if
the ongoing implementation shifts line numbers. P2 means actionable correctness
or maintenance risk, not necessarily a production incident.

### DB-01 — P2 correctness: failure writer and reader disagree

**Evidence:** `execution/node-attempt-run-store-contract.ts` accepts
`safeErrorCode` matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`;
`execution/coordinator-pending-failure-observations.ts:47` accepts only a
lowercase initial letter and lowercase remainder. The engine's
`persisted-observation-parser.ts:97` agrees with the writer.

The reviewer directly reproduced: completion outcome with
`safeErrorCode: 'Provider.Failure'` passes the writer schema, but the same
pending failure throws `CoordinatorRunStateCorruptError` in the loader.
This is a parser round-trip reproduction, not a live provider incident.

**Fix direction:** one appropriately owned failure vocabulary/grammar, reused
at writer/loader/engine seams without weakening shape, identity or bounds
validation. Do not silently lowercase persisted evidence or redefine existing
accepted codes. Avoid importing a whole engine into the database.

**Acceptance:** writer → stored failure → loader → engine tests for lowercase,
mixed case, numeric prefix, invalid punctuation, empty/overlong code, all
failure/error kinds and corrupt rows. Add a disposable database regression
that completes an attempt with a valid mixed-case code and advances its run.

### DB-02 — P2 correctness: invitation expiration has divergent owners

**Evidence:** `tenant-access/identity-workspace-invitation-store.ts:424` expires
an existing recipient during reinvite and unconditionally changes queued,
failed **and unknown** delivery attempts to canceled. Its `expireInvitations`
at line 667, `identity-workspace-invitation-deliveries.ts:3`, and worker delivery
handling preserve `unknown` while scrubbing the sealed token. The reinvite
path also omits the acceptance-intent supersession done by the list path;
acceptance resolution has another expiration subset at
`identity-workspace-invitation-acceptance-store.ts:256`.

This is statically confirmed state inconsistency: uncertain provider history
can be replaced by a false canceled outcome. Expiry checks still guard
acceptance; no unauthorized-acceptance exploit is claimed. Existing integration
coverage checks the invitation row during reinvite, not all related states.

**Fix direction:** one invitation-owned transactional expiration operation,
with explicit scoped selectors, preserving unknown history while stopping
deliverability, scrubbing tokens and superseding applicable open intents.
Reuse the existing delivery cancellation rule; no generic lifecycle framework.

**Acceptance:** list/reinvite/resolve expiry with queued, failed, unknown and
submitted deliveries; pending/verified/wrong-account intents; consistent
results, token scrubbing, unusable/superseded intents, no redispatch and safe
concurrent expiry/acceptance. Preserve tenant isolation and receipt replay.

### DB-03 — P2 correctness: purge cleanup hides operational failures

**Evidence:** `lifecycle/workspace-purge.ts:685` and `:858` catch failures after
claiming, release the claim, and return ordinary `released`/`stale` without the
cause. `apps/retention/src/maintenance-loops.ts:353` then calls
`recordOperationRecovery()`. Invalid ledger records, append failures and SQL
projection failures can therefore look like healthy recovery. The existing
`workspace-purge-foundation.integration.test.ts:1670` explicitly expects an
invalid repeated hash to return `released`.

**Fix direction:** preserve resumability and release, but surface the original
failure or a typed failure result the runner recognizes. Preserve both errors
when release also fails. Keep benign claim races/fence changes distinct.

**Acceptance:** invalid record/hash, append failure, projection failure and
cleanup failure retain diagnostics; backoff/failure metrics apply; recovery
only follows healthy work; retry remains idempotent. Use disposable fixtures,
never a user's workspace purge as a test.

### DB-04 — P2 responsibility: output loader guesses control semantics

**Evidence:** `execution/coordinator-run-store-observations.ts:425`, function
`completedInlineOutput`, decides whether outputs should reach the engine by
looking for `selectedPort`, `branchIds`, or the exact two-field
`{items, iterationCount}` shape. It also embeds a 1,000-item control limit.
The database consequently knows the output language of Condition, Switch,
Parallel and For Each. This is separate from the N4 continuation heuristic.

**Fix direction:** control-output requirements must be explicitly selected by
engine/compiled execution metadata, not guessed from user object properties.
The database remains responsible for bounded retrieval, identity/ownership,
storage-format validation and snapshot consistency. Do not load every output
unboundedly as a shortcut, or let arbitrary callers request other runs' values.

**Acceptance:** all current control families and retained versions; ordinary
Set outputs containing the same property names; malformed control outputs;
inline/artifact rules; observation-window limits; restart and redelivery.
Explain how a new control node no longer requires a DB property-name edit.

### DB-05 — P2 contract duplication: schedule validators diverge

**Evidence:** `triggers/schedule-recurrence.ts:51` reimplements token, timezone,
interval and parser restrictions also in `nodes-core/src/schedule/validation.ts`.
`triggers/workflow-trigger-projection.ts:7` additionally copies a legacy schema.
A 307-character expression made from `Array(150).fill('0').join(',') +
' * * * *'` is rejected by the current node schema but accepted by the DB
recurrence parser. This is demonstrated parser drift, not an asserted public
route validation bypass.

**Fix direction:** reuse an existing shared, version-aware recurrence contract.
Keep database column translation and recurrence/DST computation appropriately
owned. Do not force new restrictions onto immutable legacy node versions or
change stored fingerprints.

**Acceptance:** parity corpus through node validation, projection/materialization
and persisted input; maximum lengths, tokens, timezones, interval limits;
legacy compatibility, DST/misfire and schedule-fire tests stay green.

### DB-06 — P2 responsibility: placement policy lives in a DB factory

**Evidence:** `authoring/workflow-authoring.ts:107–193` recursively traverses
graphs and decides whether retained unavailable definitions may stay versus
which newly placed definitions are forbidden. It is pure graph policy beside
pool acquisition/store composition; drafts and version restoration both use it.

**Fix direction:** move the pure placement decision into the existing
workflow-model graph/compatibility area. The DB still obtains the locked release
and invokes that decision inside authoritative save/create/restore operations.
Preserve outward errors and issue paths; no new service or package is needed.

**Acceptance:** retained unavailable definitions, new placement, nested bodies,
duplicate/moved occurrence behavior, and real draft/restore compatibility races.

### DB-07 — P2 interface/duplication: command hash helpers imply more than they support

**Evidence:** independent canonicalizers/hash utilities live in
`tenant-access/identity-workspace.ts:195`, invitation-store `:78`,
invitation-acceptance-store `:152`, member-command `:25`, and rename-store `:26`.
Profile commands import generic primitives from the member-command module.
Some recurse with ordinal sorting, another uses locale sorting, and the
member/rename variants use a JSON replacer array of top-level keys.

The reviewer reproduced that `commandRequestHash({profile:{name:'A'}})` equals
the hash for `{profile:{name:'B'}}`. Current member/profile callers use flat
payloads, so this is an overbroad generic interface and latent collision risk,
not evidence of a currently exploitable command replay collision.

**Fix direction:** own identity-command primitives in one appropriate module;
make historically flat hashing explicitly flat/scalar. Consolidate only
byte-equivalent behavior. Preserve all historical receipt and key hashes.
Do not replace different encodings with a new canonicalizer without a retained
compatibility strategy. Reuse an outbox encoder only after proving identical
bytes. No generic cross-domain receipt framework.

**Acceptance:** golden hashes for each existing command family and retained
receipt replay; insertion-order invariance; nested input rejected or explicitly
versioned; existing outbox checksums preserved. Include no-secret diagnostics.

### DB-08 — P2 maintenance: abort-safe checkout has multiple owners

**Evidence:** `operator/operator-transaction.ts:24`,
`lifecycle/control-ledger-postgres.ts:43`,
`lifecycle/retention-transaction.ts:62`, and
`tenant-access/workspace.ts:258` separately manage checkout racing abort,
late fulfillment/rejection, listener removal and client disposal. Their
pre-abort and late-client handling differ. No new connection leak was proved.

**Fix direction:** consolidate only identical checkout/ownership mechanics in
platform support. Keep caller-specific error identity, dirty-client disposal,
tenant hygiene, advisory locks, roles and unknown-COMMIT behavior explicit.
Do not build an option-heavy universal transaction runner.

**Acceptance:** pre-abort, queued abort, grant/abort race, late fulfillment and
rejection, release exactly once, hostile rejection values; retain transaction,
operator, control-ledger and real-driver cancellation integration coverage.

### DB-09 — P3 maintenance: authoring injects invariant mappers inconsistently

**Evidence:** `workflow-authoring.ts:333` uses a version-restore context for
several commands; rename uses lifecycle context; publication/restore inject
fixed row mappers that drafts/reads import directly. No alternate mapper
implementation is selected.

**Fix direction:** consistent direct imports for fixed pure row mapping; a
small authoring-owned context for genuinely variable transaction,
authorization, compatibility and test-hook dependencies. Retain compiler
injection and concurrency fault hooks. Keep the public factory stable.

**Acceptance:** authoring typecheck and draft/publication/restore/lifecycle/
rename tests; identical outward results and errors; less interface knowledge,
not more wrapper modules.

### DB-10 — P3 policy ownership: trigger read roles are hard-coded separately

**Evidence:** `triggers/schedule-trigger-reads.ts:88` and
`triggers/webhook-trigger-deliveries.ts:121` contain their own role arrays;
mutation access uses the shared workspace policy.

**Fix direction:** give the existing read policies a named owner in workspace
policy. **The differing role sets are intentional (ADR 045/048).** Do not grant
webhook delivery access to every schedule reader. Transactional active-user,
membership and workspace checks remain in persistence.

**Acceptance:** explicit role matrices for both families, mutation/read
distinction, unchanged non-disclosing denials and no permission widening.

### DB-11 — P2 responsibility: preview store assembly leaks into the worker

**Evidence:** `apps/worker/src/execution/preview-attempt-runtime.ts:74` and
`preview-reconciliation-runtime.ts:49` acquire database pool leases and assemble
pool-oriented persistence operations. The normal node-attempt store factory
already hides this implementation inside database. Preview also adapts durable
lease authority in the worker. Transactions themselves are guarded; this is
an inconsistent, shallow interface, not a demonstrated transaction bug.

**Fix direction:** let database own the preview store factory, pool lifetime
and durable contract. Worker retains executor invocation, queue orchestration,
telemetry and error mapping. Preserve distinct preview semantics; do not merge
preview and normal execution into a generic framework.

**Acceptance:** worker preview adapters no longer acquire raw pools; shared
runtime closing, abort, claim, fencing, heartbeat, completion, reconciliation,
crash and redelivery tests pass through the production store interface.

### DB-12 — P3 protocol duplication: invocation-key encoding has three owners

**Evidence:** `execution/node-attempt-run-store-transactions.ts:13`,
`compatibility/persisted-workflow-checkpoint-refinements.ts:198`, and engine
`scheduling.ts:238` implement the same URI-encoded version/node/branch/iteration
key format independently.

**Fix direction:** one pure, retained-compatible key codec in an existing
neutral module; consumers retain their validation and adapt representations.
This is not the workflow-model SHA256 invocation-identity contract. Do not
conflate those formats or rekey stored runs.

**Acceptance:** byte-exact golden fixtures for root/branch/nested iteration,
escaping, legacy keys, and writer/checkpoint-parser/engine agreement.

### DB-13 — P3 redundancy: a test-only reconciliation mutation path remains

**Evidence:** `execution/preview-execution-reconciliation.ts:94` implements
`reconcileExpiredPreviewAttempt` independently of the production durable
delivery path. Repository-wide references are its internal/testing exports and
`preview-worker-reconciliation.integration.test.ts`; the production worker uses
`reconcilePreviewDelivery`. A second terminal-mutation implementation exists
mainly to support a test seam.

**Fix direction:** move the behavioral tests onto the production durable
delivery seam, then remove the unused alternate mutation path if a fresh
caller search still confirms no production user. Preserve every behavioral
case and durable receipt/fence assertion; do not delete tests to reduce count.

**Acceptance:** unsafe ambiguity, undispatched/reclaimable attempts, terminal
redelivery and missing/mismatched delivery coverage on the real store path;
no remaining exports/callers of the removed alternate implementation.

## Related node fix: prerequisite, not duplicate work

N4 is replacing the database's event-name-based continuation inference with
engine-owned intent. That was a real responsibility leak, but an edit on disk
does not close it. N1–N3 and the serial-loop restart/redelivery regression must
also pass independent review before this batch starts.

## Necessary complexity — do not delete as “redundant”

- Tenant context establishment/read-back, RLS, locked authorization checks,
  revision/fence tokens and command receipts. HTTP authorization does not
  replace checks against current locked state.
- Separate API/worker/operator roles and deliberately narrow SQL-function
  adapters. A thin adapter can still enforce a meaningful privilege seam.
- Immutable execution versions, persisted format validation and retained
  legacy contracts. Schema validation and semantic checks serve different jobs.
- Atomic checkpoint/event/outbox/receipt writes and recovery reconciliation.
- ADR 013 cross-store lifecycle coordination, legal holds, ledger ordering and
  advisory locks. Being housed in database does not make these automatically
  misplaced. Reserved pool capacity prevents coordinator deadlocks.
- Provider dispatch evidence and `outcome_unknown`; do not invent certainty to
  simplify state handling.
- Both legacy/native session revocation during migration, single-use proof and
  cross-workspace invitation lineage handling.
- Startup schema/grant/function-body drift checks versus lighter serving
  readiness. Repetition of expected metadata is deliberate verification, not
  automatically duplicate domain policy.
- Migration checksums and explicit historical compatibility exceptions. Never
  delete published migrations or rewrite their SQL to tidy the history.
- Driver cancellation adapter: pg-specific wire cancellation is isolated and
  pinned. It deserves driver tests, not removal just because it uses internals.

## Lower-priority observations, not automatic implementation orders

- At the time of this review, execution's flat directory mixed attempts,
  coordinator, preview, artifacts and delivery. The later bounded directory
  follow-up grouped these owners after correctness closure; file count alone
  was not treated as a defect.
- Publication reads every retained version graph to find an equal checksum
  (`workflow-publication.ts:256`). Measure history-size costs before changing;
  preserve selected-version validation and version-allocation locks.
- Similar receipt SQL across schedules, webhooks and destinations has different
  replay semantics. Do not flatten those differences into a generic repository.
- Full internal connection factories then select role-specific methods. Some
  bindings are redundant, but no privilege leak or compelling rewrite was shown.
- Type-only dependency cycles are not runtime initialization cycles; the actual
  architecture check passed. Do not refactor them based on regex-only scans.

## Coverage and evidence

The inventory at review time is **229 TypeScript source files**, about 48k lines.
Every source directory was assigned and structurally inspected; depth differs
between executable modules, declarative schemas and large readiness SQL.

| Area | Files | Review depth |
| --- | ---: | --- |
| execution + compatibility + validation | 94 | Implementation/contract review, selected worker/engine callers and tests |
| tenant-access + identity + authoring + connections | 55 | All source bodies, selected HTTP adapters/ADRs/tests |
| triggers + lifecycle + operator | 41 | All source bodies, selected callers/ADRs/tests |
| platform | 14 | Runtime/migration/telemetry ownership; readiness SQL capability/assembly and targeted predicates |
| schema | 11 | All declarative modules and relationships; table-ownership check |
| root modules | 14 | Exports/config/factories/migration runner and schema assembly |

Counts include testing barrels, contracts and errors; these are not all large
implementations. The source inventory and scopes, rather than file count, are
the coverage claim. This is **not** a fresh line-by-line audit of all historical
migration SQL, every test body, or all consuming applications. No directory is
silently excluded: the migration inventory and raw-table registry were checked,
while specific SQL behavior is checked where findings depend on it. Any new
SQL change requires its own forward/prior-head review and disposable tests.

Fresh verification in this review:

- `pnpm --filter @pertexo/database test`: **791 passed / 115 files**.
- `pnpm architecture:check`: **19 harness tests passed**; real workspace
  references/import ownership and static runtime-cycle checks passed.
- `pnpm database:schema:check`: **5 harness tests passed**; all **89 migration
  tables accounted for (60 typed, 29 intentionally raw SQL)**. This is an
  ownership check, not column-by-column schema equivalence.
- Focused reviewers additionally ran 73 identity/authoring/transaction tests
  and 181 lifecycle/operator/schedule tests; these overlap the 791 and must not
  be added to claim a larger unique total.
- Direct, read-only parser/hash reproductions establish DB-01 and DB-07;
  schedule parser reproduction establishes DB-05. DB-02/03 are source/caller
  and existing-test evidence, with new integration regressions required.

No service-backed integration suite, destructive lifecycle rehearsal, real
provider call or production verification was rerun for this structural pass.
Existing green tests do not close the findings. The working tree is changing
under the independent node-fix task; final verification must use its completed
diff, not these point-in-time counts.

## Package-wide pattern matrix

This is a consistency review across counterparts, not a demand for identical
files. Paths below are relative to `packages/database/src` unless qualified.
The findings above supply the detailed evidence and behavioral acceptance
criteria. This matrix supplies the structural acceptance criteria. Every row
needs a final disposition: **conforms**, **fixed**, **justified exception**, or
**blocked**, with paths and evidence. None is closed merely by creating a
shared helper.

| Family and reviewed counterparts | Intended pattern / owner | Required disposition |
| --- | --- | --- |
| Pool ownership: `platform/database-runtime`, store factories in authoring, connections, identity, execution, triggers, lifecycle and operator; worker preview runtimes | Store factories own pool acquisition and lease closure. Applications own injected runtime lifetime; closing a store must not close a shared runtime. | DB-11: bring preview persistence assembly behind the database interface; retain separate preview and workflow contracts. Keep role-specific exports. |
| Cancellation-aware acquisition: `tenant-access/workspace`, `operator/operator-transaction`, `lifecycle/retention-transaction`, `lifecycle/control-ledger-postgres`, `execution/coordinator-schedule-observation` | Platform owns equivalent acquisition/listener/late-settlement mechanics. Callers own cancellation error identity, transaction policy and diagnostic versus durable outcomes. | DB-08: examine **all five** counterparts. Reuse the primitive where equivalent; explicitly document any retained diagnostic variant. Test single release and late rejection. |
| Other direct checkout: `execution/dispatcher-claim`, `compatibility/compatibility-release-maintenance`, `migrations`, `identity/check-better-auth-cutover` | Specialized transaction or process owners, not automatically copies of cancellation-aware acquisition. | Preserve explicit privilege, commit/rollback and process lifetime contracts. Do not introduce signals or a universal transaction runner solely for symmetry. Review touched paths for cleanup and uncertain commit handling. |
| Command structure: authoring drafts/publication/lifecycle/rename/restore; workspace/member/profile/invitation commands; trigger commands; connection commands | Readable sequence: parse input, enter the correct transaction, establish current authority, apply command-specific replay/fence rules, perform atomic changes and evidence writes, map result. | DB-02/07/09: make equivalent steps consistent without reordering replay or locks for aesthetics. Keep command bodies explicit; share stable mechanics, not a callback-heavy command framework. |
| Replay identity and serialization: identity workspace/member/profile/rename/invitation/acceptance hashes; authoring request hashes; trigger projection fingerprints; outbox and stored execution value serializers | An encoding is a durable protocol. One owner per equivalent protocol; constrained input types and explicit version/limits. | DB-07/12: preserve old hash/key bytes with golden fixtures. Record why flat receipt, recursive receipt, outbox, trigger fingerprint and stored-value encodings remain distinct where required. No blanket canonicalizer replacement. |
| Input/row/historical validation: execution completion and pending failures, checkpoint compatibility, schedule node/projection/recurrence, identity row and receipt schemas | Validate each trust seam using shared vocabulary when the contract is identical; retain shape/version-specific adapters. | DB-01/05/12: parity and round-trip tests. Current rows and historical receipts need not use one schema. Do not weaken persisted corruption checks to remove repetition. |
| Pure decisions: authoring placement, coordinator control-output selection, continuation scheduling, recurrence contracts | Workflow meaning belongs to model/engine or the established node contract owner; database owns atomic persistence and authoritative reads. | DB-04/05/06 plus prerequisite N4: delete displaced decisions at the old location, trace callers, preserve bounded materialization and locked invocation of decisions. |
| Authorization: `tenant-access/workspace-policy`, authoring actor check, connection authority, artifact upload, member reads, trigger management and trigger reads | Named policy owns role meaning; transaction code checks current membership and protected state with appropriate locks. | DB-10: named read policies preserve intentional schedule/webhook differences. Repeated locked checks are retained, not mistaken for redundant HTTP validation. |
| Mapping and dependencies: authoring reads/drafts/restore/publication/lifecycle/rename; connection row codecs; execution row/observation adapters | Direct-import fixed pure mapping functions. Inject dependencies that really vary, such as compiler, clock or external adapter. Context names describe their actual shared owner. | DB-09: remove mapper plumbing and misleading command-specific shared contexts. Preserve historical receipt mappers and genuine test/concurrency seams. No generic `helpers` dumping ground. |
| Lifecycle state changes: invitation expiry/revoke/delivery retirement; purge claim/ledger/projection; attempt and preview completion/reconciliation | One owner per identical transition. Keep external uncertainty, fenced writes and atomic evidence intact. | DB-02/03/13: remove alternate transition copies only after callers/tests move to the authoritative path. Cross-store lifecycle coordination remains intentional under ADR 013. |
| Error and cleanup reporting: workspace/operator/retention transaction runners, purge coordinator, execution expected claim outcomes, diagnostic observation | Expected contention/stale outcomes remain typed results; corruption/operational failures remain diagnosable. Cleanup must not erase durable-operation failure. | DB-03/08: preserve primary and cleanup failure evidence. Best-effort telemetry may intentionally return no observation; that is not a precedent for swallowing command failure. |
| Public and testing interfaces: role-specific root exports, internal testing barrels, preview reconciliation, real store factories | Consumers and behavioral tests cross the production interface; internal tests may exercise pure codecs and mechanics without creating a competing mutation implementation. | DB-11/13: remove orphan exports and alternate mutation path after preserving behavioral tests. Rerun import ownership and public contract checks. |
| Schema, migration and platform support: declarative schema, raw-table registry, migration execution/checksums, readiness/telemetry/disposal | Explicit schema ownership and established process lifetime. Startup checks and serving readiness have different costs and purposes. | Retain historical checksums and deliberate raw SQL ownership. No migration rewrites or file splitting by size. Existing guard results are coverage evidence, not proof of SQL equivalence. |

### Readability, structure and reuse acceptance

For every touched module, the implementer and reviewer must check these items
against the actual code, not just state that best practices were followed:

- **Discoverability:** file and symbol names identify the domain operation or
  stable mechanism. Keep changes within established domain directories. Avoid
  unrelated reorganizations, ambiguous `utils`/`manager` files, and splitting
  one operation into many one-line files merely to reduce line count.
- **Locality:** a rule has one authoritative implementation where its meaning
  belongs. Callers should not need to reconstruct ordering, pool ownership or
  serialization internals. Show the removed copies and the remaining callers.
- **Readable control flow:** retain visible transaction and side-effect phases;
  avoid nested callback frameworks, mode flags, speculative base classes and
  wrappers that only relay arguments without enforcing an invariant.
- **Honest types:** types describe accepted inputs and distinguish domain
  outcomes. Do not use `unknown` or generic records to imply unsupported nested
  hashing, hide uncertainty with casts, or broaden an interface to make reuse
  convenient. Validation of untrusted persisted material remains necessary.
- **Useful reuse:** share code only when its semantics, compatibility and error
  behavior match. A shared mechanism with small explicit adapters is preferable
  to many copies; a many-option universal abstraction is not.
- **Minimal state:** retain only state required to distinguish transaction,
  lease, replay and cancellation phases. Do not remove safety state without
  tests showing equivalent ownership and failure handling.
- **Comments explain constraints:** document historical byte compatibility,
  lock ordering, uncertainty and privilege decisions, not obvious syntax.
- **Complete replacement:** remove superseded helpers, imports, exports and
  test-only production paths. Do not leave an old and new implementation active
  or mark a finding done because the new helper exists.

### Counterpart closure evidence

The follow-up comparison also identified these items that must receive an
explicit disposition, without inflating them into unproven vulnerabilities:

- **Key validation (DB-07):** workspace creation, authoring, connection and
  invitation-management schemas reject commas; member/profile/rename and
  acceptance schemas do not. Check the actual callers and HTTP contract before
  consolidating. Preserve existing valid receipt keys; do not claim a header
  bypass from persistence-schema differences alone.
- **Receipt ownership:** `triggers/workflow-triggers.ts` manages its inbox
  receipt directly, whereas `operator/operator-run-replay.ts` uses
  `execution/inbox.ts`. The generic consumer records a durable transport
  security fact for receipt checksum mismatch; trigger reconciliation rejects
  the mismatch but its worker maps it to an unrecoverable error without that
  same fact. Resolve and document the intended audit contract. No universal
  mismatch-audit requirement or exploit was established in this pass. Any
  consolidation must preserve pre-effect identity checks, duplicate handling,
  stale-publication receipt commit, error mapping and transaction ownership.
- **Cancellation interface:** trigger reconciliation does not accept an abort
  signal although its worker context has one. Check the intended shutdown
  contract and tests; do not label this a demonstrated shutdown failure or add
  a new cancellation framework just for signature symmetry.
- **Policy counterparts:** invitation management and workspace rename have
  explicit owner/admin admission. Include them in the policy inventory, but
  distinguish those deliberate operation rules from the trigger read-policy
  duplication in DB-10.
- **Receipt result variants:** leave/ownership-transfer retries, invitation
  acceptance and global profile commands intentionally replay after relevant
  current state has changed. Keep their ordering and result semantics; a
  uniform visual command template must not invalidate successful retries.

At handoff, append a compact result for each matrix family: authoritative
owner, changed/retained counterparts, reason for retained exceptions, removed
duplication, and tests. Use fresh repository-wide caller searches to catch
remaining copies and consuming applications. Search results identify candidates;
they are not by themselves proof that two contracts are equivalent.

Additional concrete defects discovered while closing a family belong in this
same report with evidence and acceptance criteria. Do not stop at thirteen as a
quota, and do not invent new findings to increase the count. Unmeasured
performance ideas and merely stylistic preferences stay separate from required
fixes. No audit can guarantee absence of every defect; completion means the
declared coverage, contracts and acceptance evidence have been checked.

## Implementation order and closure

1. Independently close node audit N1–N4 first; send bounded follow-ups if needed.
2. DB-01–03: correctness and truthful state/error handling, with regression tests.
3. DB-04–06 and DB-11: explicit ownership of control output, recurrence,
   placement and preview persistence.
4. DB-07–10 and DB-12–13: compatible shared primitives and simpler existing
   interfaces; move tests to production seams before deleting alternate code.
5. Review the resulting diff, test behavior at public seams, rerun affected
   database/worker/model suites and architecture/schema/type/lint checks.
6. Close every pattern-matrix row and inspect the final combined diff for
   leftover copies, unnecessary abstractions and inconsistent new conventions.
   Passing individual regression tests does not replace this structural pass.

For each finding the implementer must report changed files, what was removed
or centralized, preserved invariants, exact tests and results, and any remaining
limitation. A finding may be rejected only with concrete source/contract/test
evidence recorded here, not silently skipped. Do not mark structural-only work
as a runtime fix, or green mocked tests as production verification.

Keep all unrelated dirty changes intact. Leave the final diff uncommitted for
the user's review. This audit is the task list; do not create another sprawling
architecture plan or speculative platform abstraction.

## Correction evidence in the current working tree

- DB-01: `@pertexo/workflow-model/attempt-failure` now owns the retained
  mixed-case/numeric-prefix safe-code grammar. The node-attempt writer schema,
  pending-failure loader and engine persisted-observation parser import it;
  the lower-case-only loader copy was removed. The database parser cases pass
  30/30 and engine persisted-code cases pass 3/3. A disposable PostgreSQL test
  completes an executor failure with `Provider.Failure`, loads it, commits the
  terminal coordinator decision and confirms the persisted code/run status:
  1/1 passed (15 filtered). Preview's narrower code contract remains distinct.
- DB-02: invitation expiration has one transaction-local owner in
  `identity-workspace-invitation-expiration.ts`, called by listing, reinvite,
  resolver and management. It locks/updates the invitation before retiring
  delivery and acceptance evidence, preserves `unknown` while scrubbing sealed
  material, and supersedes open intents. Management returns an internal expiry
  outcome so the expiration commits before the public conflict is thrown.
  Disposable PostgreSQL tests passed for reinvite unknown+pending intent
  (1/1), list expiry with queued/failed/unknown/submitted evidence (1/1), and
  resolver expiry (1/1). An additional disposable PostgreSQL test covers
  cleanup of already-expired rows with verified and wrong-account intents
  (1/1), preserving unknown delivery history while scrubbing its token. A
  concurrent list-expiry versus verified acceptance test passes (1/1): the
  command is rejected, intent superseded and no membership granted. Full
  delivery/acceptance interleavings remain a wider integration gate.
- DB-03: after a claimed purge failure, the coordinator attempts fenced claim
  release and now rethrows operational/ledger failures; release failure retains
  both errors in `AggregateError`. Expected claim/fence/legal-hold outcomes
  still return typed idle/released/stale results. Three disposable PostgreSQL
  purge tests passed for ambiguous start append, ambiguous completion append,
  and invalid repeated hash (3/3, 6 filtered). Disposable PostgreSQL trigger
  injection now proves projection failure is surfaced, the claim is released
  and retry projects the one durable record; a separate injection proves an
  `AggregateError` retains both the ledger and release failures (2/2, 9
  filtered). Retention unit tests pass 100/100, including purge failure/backoff.
  The projection-failure regression now selects its target after other due
  work and checks that retry uses the same one durable ledger record.
- DB-04: the loader now selects inline control outputs using the immutable,
  compiled V2 executable envelope (`graph.nodes`) read in the same
  run/checkpoint snapshot. Definition-based
  control identity lives in workflow-model and is used by engine scheduling;
  database property-name/shape guesses and the duplicated 1,000-item check
  were removed. Disposable PostgreSQL observation, Parallel and For Each
  files pass 42/42, including Condition/Switch, corrupt compiled envelopes,
  and ordinary outputs with each former sentinel shape. Model tests pass
  124/124; six engine tests compile and serialize real V2 envelopes for
  Condition, Switch, Parallel v1–v3 and nested ForEach. The fixture supplies
  nested compiled-envelope nodes at version creation because published
  versions are immutable. The final combined disposable database integration
  rerun passes 659/659, including the historical-hash and placement-race
  additions.
- DB-05: runtime recurrence admission now delegates its current strict cron,
  timezone and interval rules to `CORE_SCHEDULE_CONFIG_SCHEMA_V2`; the local
  duplicated grammar/parser check was removed. Trigger projection imports
  both the existing V1 and V2 node schemas rather than maintaining a copied
  V1 schema. Focused schedule/projection tests pass 20/20, including the
  307-character expression, a V1 fingerprint golden and persisted V1
  compatibility. The combined disposable PostgreSQL suite passes 659/659,
  including schedule/DST/fire coverage.
- DB-06: pure placement policy now lives in
  `@pertexo/workflow-model/graph/definition-placement`; the database invokes
  it inside locked writes and keeps the outward placement error. Model tests
  pass 2/2, including nested and duplicate occurrences; database
  compatibility unit tests pass 4/4 and real version-restore PostgreSQL
  tests pass 7/7. Existing real save/publish and save/restore lock-order races
  passed in the full integration suite. A deterministic placement-specific
  PostgreSQL race now activates the next compatibility release while a save
  waits on its pointer lock: the racing save fails closed with a compatibility
  mismatch; a deliberate retry against the new release reports the blocked
  definition, and the draft stays at revision 1 (1/1 focused and included in
  the 659/659 combined integration rerun).
- DB-07: the historically flat member/profile/rename hash now has one
  `identity-command-primitives.ts` owner. Its TypeScript input now admits only flat
  scalar values, while runtime inspection rejects nested/undefined values
  instead of silently colliding; golden bytes and insertion-order tests pass.
  The same identity-command owner now holds the exactly equivalent printable
  key and positive-revision schemas used by member, profile and workspace
  rename commands; commas remain accepted in those persistence schemas.
  Recursive workspace/invitation and acceptance encodings remain
  separate because their retained protocols differ. A member-role golden was
  added to the flat profile/rename fixtures. Real command-path PostgreSQL
  regressions pin independent historical request-hash digests for workspace
  creation, invitation creation and acceptance, plus the invitation outbox
  checksum's canonical field order; their exact replay/conflict cases pass
  (3/3 focused, with 63 unrelated tests filtered). Other retained command
  variants continue to use distinct encodings; no migration or receipt rewrite
  was performed. The 659/659 combined integration rerun passed.
- DB-08: the identical abortable pool-checkout race now lives in
  `platform/abortable-pool-checkout.ts`. Workspace, operator, retention-lock
  and control-ledger callers keep their own abort reason, late-client disposal
  and transaction cleanup policies. The new primitive tests pass 6/6,
  including abort/grant same-turn with a hostile late release and a hostile
  rejection object. The helper now returns the caller-selected abort reason
  without wrapping it; control-ledger preserves even non-Error reasons on
  queued and pre-aborted checkouts, while its client-disposal boundary still
  converts to Error. Focused caller cancellation tests pass 20/20; retention/control-ledger
  PostgreSQL cancellation suites pass 9/9. The fifth counterpart,
  `coordinator-schedule-observation`, remains a diagnostic-only query-deadline
  variant, not an identical command checkout.
- DB-09: fixed draft/version/workflow row mapping is now directly imported
  by drafts, restore, publication, lifecycle and rename. The injected
  `WorkflowAuthoringWriteContext` names only variable transaction, authority,
  compatibility and test seams; misleading version-restore/lifecycle context
  reuse and an unused rename lock argument were removed. Seven real
  PostgreSQL authoring suites pass 45/45.
- DB-10: named schedule and webhook read policies now live in workspace
  policy. Role-matrix tests pass 2/2; schedule/webhook PostgreSQL read tests
  pass 31/31, retaining their intentionally different role sets.
- DB-11: preview attempt and reconciliation store factories now live in
  database; worker retains execution and queue orchestration. The moved store
  tests pass 5/5, worker unit tests 798/798, and real preview delivery/crash
  integration tests 2/2. A real PostgreSQL shared-runtime test proves closing
  both preview store leases does not close the injected runtime pool (2/2
  focused). The combined 659/659 PostgreSQL suite includes preview claim,
  fencing, completion and reconciliation paths; the controlled worker preview
  delivery/crash cases passed 2/2. No external-provider proof is claimed.
- DB-12: one retained V2 invocation-key encoder in workflow-model replaces
  writer/checkpoint/engine copies. Model golden tests pass 2/2; database and
  engine typechecks pass. Cross-consumer database and engine golden tests pass
  1/1 each; a database V1 legacy-key round-trip passes (8/8 focused file).
  The disposable PostgreSQL observation suite also passes its legacy-key
  preservation/admission case; the engine and checkpoint-parser tests pin
  modern writer/reader bytes. A single cross-process restart/replay journey
  dedicated to this codec was not added.
- DB-13: the alternate `reconcileExpiredPreviewAttempt` implementation and
  exports were removed after moving its behavioral cases to the production
  durable-delivery path. The complete disposable PostgreSQL preview
  reconciliation file passes 7/7, covering unsafe uncertainty, reclaimable
  work, redelivery, receipts and mismatch handling.

Database unit tests pass 836/836 (120 files),
nodes-core tests 109/109, retention tests 100/100, workflow-model tests
124/124 and workflow-engine tests 401/401. Worker unit tests pass 799/799.
Database, model, engine and worker typechecks, affected-package
lint, architecture (19/19), schema (5/5; 89 tables), and `git diff --check`
pass. Focused PostgreSQL tests use disposable fixtures. The clean full
database integration rerun passed 659/659 (97 files) before the final bounded
checkout/validation ownership cleanup; focused post-cleanup suites are below.
The first run passed
646/648: a purge regression assumed its target would be the next due
workspace, and an authentication-mail retry did not appear. The purge test
now selects the target and verifies its durable ledger record; both files
passed in isolation and on the full rerun. Remaining acceptance gates and
package-wide pattern dispositions below retain specific open gates. No production database or
provider was used, and no commit or push was made.

The worker's direct Schedule integration command initially skipped because
its opt-in flag was absent. Rerunning with `WORKER_TRIGGER_INTEGRATION=true`
used its namespaced Redis queue and disposable PostgreSQL fixture and passed
1/1. This is local controlled runtime evidence, not a provider or production
run.

### Combined counterpart disposition (latest caller search)

These are structural dispositions, not a claim that all behavioral gates are
closed. Searches covered the database source, model, engine and worker callers.

| Family | Owner and changed/retained counterparts | Disposition and evidence |
| --- | --- | --- |
| Pool ownership | Database preview attempt/reconciliation factories now own leases; worker uses exported stores. Other domain factories and injected runtime stay separate. | **Fixed, with justified runtime ownership.** Shared-runtime PostgreSQL 2/2; database integration 659/659; worker unit 799/799. |
| Cancellation-aware acquisition | `platform/abortable-pool-checkout` serves workspace, operator, retention and control ledger. Schedule observation keeps its diagnostic query deadline. | **Fixed for four identical races; justified fifth variant.** Primitive 6/6, caller 20/20, cancellation PostgreSQL 9/9. Direct dispatcher, migration and cutover checkouts remain process-specific. |
| Command structure | Domain commands retain explicit locked authority, replay ordering, atomic evidence and typed outcomes. Invitation expiry has one transaction-local operation; authoring has a smaller shared context. | **Fixed where equivalent; otherwise justified.** Identity, authoring, invitation and full database integration tests passed. Cross-domain command framework deliberately absent. |
| Replay encodings | Flat member/profile/rename hashing has one constrained owner. Workspace, invitation and acceptance retained encodings, trigger fingerprint, stored-value and outbox encoders remain distinct. | **Fixed for the audited families.** Flat and trigger fingerprint goldens, real stored workspace/invitation/acceptance receipt digests, invitation outbox byte-order checksum and replay/conflict tests pass. HTTP rejects comma keys; selected persistence schemas allow historical comma-bearing keys, which are digested and do not imply a header bypass. Other operation variants retain their original bytes; no universal canonicalizer was introduced. |
| Validation seams | Shared failure-code grammar and V2 invocation-key codec replace copies; current schedule recurrence delegates to node V2 schema and projection uses V1/V2 schemas. Row/historical adapters remain. | **Fixed with historical exceptions.** Model 124/124, engine 401/401, database unit 836/836 and integration 659/659 before the final bounded cleanup; focused post-cleanup integration results below. |
| Pure workflow decisions | Model owns definition placement and control identity; engine owns output meaning and continuation; node schema owns recurrence admission. Database keeps locked invocation, bounded snapshot retrieval and row validation. | **Fixed for the local acceptance scope.** Compiled V2 envelope tests 6/6, focused database controls 42/42, nested/duplicate model placement 2/2; the activation/save race fails closed and rejects a new unavailable definition on deliberate retry (1/1 focused PostgreSQL). |
| Authorization | `workspace-policy` owns named schedule/webhook read role sets. Invitation management and rename retain explicit command admission; persistence checks current locked state. | **Fixed, with intentional role differences.** Role matrix 2/2 and trigger read PostgreSQL 31/31; no policy widening. |
| Mapping/dependencies | Authoring's fixed row mappers are direct imports; context retains varying transaction/authority/compatibility/test seams. Connection and execution codecs remain domain-local. | **Fixed.** Seven authoring PostgreSQL suites 45/45. |
| Lifecycle transitions | Invitation expiration and production preview reconciliation each have one path. Purge retains ADR 013 ledger/claim coordination and now surfaces failures. | **Fixed with distinct uncertainty contracts.** Preview reconciliation PostgreSQL 7/7, purge failure PostgreSQL 5/5, retention unit 100/100. |
| Errors and cleanup | Transaction callers retain typed expected contention, while purge propagates operational and cleanup failures. Diagnostic schedule observation may return no observation. | **Fixed/justified.** Purge injection and cancellation cases pass; diagnostic path is not a command-failure precedent. |
| Public/testing interfaces | Database execution exports production preview factories; alternate test-only reconciliation mutation and callers are gone. Role-specific barrels remain. | **Fixed.** Caller search found no `reconcileExpiredPreviewAttempt`; architecture 19/19 and schema 5/5 pass. |
| Schema/platform | Migration checksum, RLS, raw-table ownership, startup versus serving readiness and runtime disposal stay explicit. | **Justified necessary complexity.** Schema check accounts for 89 tables; disposable integration 659/659. No migration rewrite. |
| Trigger receipt/cancellation counterpart | Trigger-specific receipt remains in `workflow-triggers`; generic inbox stays with other consumers. Both now record a durable transport-security fact for a valid delivery checksum mismatch. Worker checks abort after published read, before starting reconciliation. | **Fixed/justified separate transaction owner.** Direct and existing-receipt mismatch PostgreSQL regression 4/4 focused; worker handler 11/11 and full suites above. An in-flight database reconciliation is not claimed cancelable. |

The remaining verification limits are specific: DB-02's complete external
delivery/acceptance interleaving space is not exercised against a real mail
provider, and DB-12 has cross-consumer golden/legacy PostgreSQL coverage but
no dedicated cross-process restart/replay journey for the codec. These limits
do not change the local 659/659 disposable-database result into provider or
production evidence.

## Independent review checkpoint — 2026-09-27

The reviewer inspected the combined cleanup diff and new files against
`9e39c8d0`, with separate identity/authoring, execution/compatibility and
trigger/lifecycle reviews. This is not yet final closure.

Independent main-review reruns passed:

- Database unit: 833/833 across 120 files.
- Workflow model: 124/124; workflow engine: 401/401; worker unit: 799/799.
- Six disposable PostgreSQL files: 119/119, covering identity commands and
  invitation expiry, purge failure handling, attempt outcomes, control-output
  loading, authoring coordination and preview reconciliation.
- Database typecheck, architecture check (19/19 plus actual graph), schema
  ownership check (5/5 plus 89 tables), and diff whitespace check.

The scoped reviewers found no correctness blocker in DB-01–07 or DB-09–13.
They independently ran additional focused units, overlapping the totals above.
DB-08 has one narrow remaining contract correction: control-ledger checkout
previously rejected the exact `signal.reason`; the shared helper now wraps
non-Error reasons. Preserve caller-selected cancellation identity, keeping
Error conversion only where disposal requires it, and cover queued/pre-aborted
non-Error reasons. This was sent to the implementation chat for correction.

Two final structural leftovers were also sent: remove the unused authoring
rename context argument, and move profile's generic key/revision schema
dependency out of the member-command module without changing key semantics.
No other speculative refactor is required by this checkpoint. Final closure
awaits inspection and verification of these bounded corrections.

### Bounded follow-up to the independent checkpoint

- DB-08: `acquireAbortablePoolClient` now permits a caller-selected `unknown`
  abort rejection while continuing to normalize unrelated pool rejections.
  Control-ledger checkout passes through `signal.reason` unchanged; its
  separate checked-out-client disposal still requires an `Error`. Unit tests
  cover pre-aborted and queued object reasons, late release, ordinary Error
  cancellation and hostile checkout rejection (46/46 focused across four
  files). Controlled PostgreSQL control-ledger coordinator files pass 10/10.
- DB-07: the existing flat hashes and exactly equivalent member/profile/
  workspace-rename printable-key and positive-revision schemas now live in
  `identity-command-primitives.ts`. Profile no longer imports validation from
  member-command, and the rename-local duplicate schemas were removed.
  Comma remains valid for these historical persistence keys; the separate
  comma-rejecting HTTP/invitation contracts were not changed. A unit boundary
  case covers comma, length, whitespace and positive revision. Focused real
  PostgreSQL profile/member/workspace-rename and workflow-rename cases pass
  8/8 across three files (72 other cases filtered). Database unit passes
  836/836 across 120 files.
- DB-09: `lockActiveWorkflow` no longer accepts or receives an unused rename
  context. The workflow-rename PostgreSQL cases are included in the 8/8
  focused run above. Database typecheck and affected lint pass. The last
  full 659/659 database integration run preceded these three small changes;
  no updated full-suite claim is made here. Final independent review remains
  with the audit owner.

### Final independent local closure — 2026-09-27

The audit owner inspected all three bounded corrections and verified them.
Control-ledger checkout preserves the exact cancellation reason in both
queued and pre-aborted cases; disposal still normalizes errors separately.
Member/profile/rename share the equivalent validation and hash primitives,
without changing comma-key behavior. The unused rename parameter is gone.
Fresh searches found no old hash-module references or alternate preview
reconciliation implementation in database/worker source.

Post-correction independent checks:

- Database unit: **836/836**, 120 files; database typecheck passed.
- Real disposable PostgreSQL identity, workflow rename and both control-ledger
  coordinator files: **86/86**, four files.
- `git diff --check` passed.

The earlier independent checkpoint additionally verified 119 focused
PostgreSQL cases, model 124/124, engine 401/401, worker unit 799/799 and
architecture/schema guards. The worker restart/redelivery journey was also
independently rerun after the codec consolidation: **1/1**, 39.73 seconds,
including serial, Condition, Switch and nested-loop cases. It uses graceful
process restart and manual publication of durable outbox identities, not a
production relay or arbitrary crash window. These runs overlap; do not add
them together as unique coverage. The implementer's full PostgreSQL 659/659
run predates the final three small cleanups; no post-cleanup full-suite claim
is made.

**Disposition:** DB-01–13 and the declared pattern-family cleanup are closed
for the reviewed local scope, with the documented intentional variants and
external-proof limits retained. This section supersedes earlier pending-review
checkpoint wording. No further safe local implementation is required by this
audit; broader live-provider/release validation is not implied. The recurring
follow-up can pause. All changes remain uncommitted on `feat/recorded-inputs`
(no upstream); nothing was pushed or merged, and unrelated work is preserved
for the user's final review.

### Execution directory and quality-gate follow-up — 2026-09-27

After the independent correctness closure, the execution directory was grouped
by coordinator, node attempts, previews, artifacts, transport, notifications and
runs. Invitation delivery moved to its tenant-access owner. The root execution
barrel and package subpaths remain stable. A pre-move snapshot comparison proved
all **89/89** original execution-file bodies identical after reversing only
relative import paths; later formatting and focused quality-gate reductions are
separate changes. Historical evidence links above retain their review-time
paths, while live quality baselines and the operations retention register name
the current files.

The quality follow-up shares coordinator artifact-availability validation,
isolates run-acceptance input preparation and purge claim-release recovery, and
separates loop observation/transition responsibilities. It moves preview status
and trace-context schemas into the preview contract, eliminating its reverse
dependency on acceptance, and isolates durable trigger-event reading. The
existing preview/full-run idempotency-query clone was inspected: the current
14-line fragment remains the deliberately separate operation-specific query;
only its reviewed fingerprint was refreshed, keeping the 15-line ceiling and
aggregate duplication limits unchanged. No complexity budget was raised.

Post-follow-up checks passed: model, engine, database and worker builds and
typechecks; model **124/124**, engine **401/401**, database unit **836/836** and
worker unit **799/799**; seven disposable PostgreSQL files **98/98** covering
coordinator observations, run/preview acceptance, purge failure recovery,
workflow coordination and schedule/webhook trigger reconciliation; the complete
disposable PostgreSQL database suite **659/659** across **97 files**; complexity
and duplication ratchets; architecture **19/19** plus source graph; schema
**5/5** plus 89-table ownership; built exports **35** consumer cases; scoped
Prettier, workspace/infrastructure lint, and `git diff --check`. The focused
cases overlap the complete suite; do not add their counts. Local disposable
PostgreSQL is not hosted-provider evidence. The changes remain uncommitted and
unpushed for review.
The opt-in worker For Each/cancellation recovery journey also passed **1/1**
with its disposable PostgreSQL fixture, isolated Redis namespace and fresh
worker processes; its default-disabled invocation was skipped and is not
counted as evidence.
The repository-wide `format:check` remains red on **19** unrelated paths:
dirty `CONTEXT.md` and generated artifacts inside a nested `.claude/worktrees`
checkout. Those files were preserved rather than reformatted as part of this
follow-up.

### Independent pre-push checkpoint — 2026-09-27

The reviewer independently cleared the final extraction and baseline diffs:
artifact validation, acceptance preparation, loop observations/transitions,
purge recovery and durable trigger reading preserve their reviewed contracts.
Complexity limits are unchanged; the retained idempotency clone fingerprint
was independently recomputed and remains below its unchanged 15-line ceiling.

Fresh independent checks passed: model 124/124, engine 401/401, database unit
836/836, worker unit 799/799, all 659 disposable PostgreSQL database tests,
the opt-in worker restart/redelivery journey 1/1, authenticated webhook HTTP
tests 8/8 and the run-detail UI file 9/9. The HTTP invocation initially stopped
at its missing-configuration gate; rerunning with the repository's local test
connection defaults passed. The four affected package typechecks, architecture,
schema ownership, built exports, documentation links, complexity, duplication,
staged-file formatting and whitespace checks passed. Service tests use owned
disposable fixtures; this is not production or external-provider qualification.

Reviewed code is recorded in `2cc6cdce` (shared model contracts) and `713781fe`
(execution fixes and persistence organization). Unrelated frontend changes,
`CONTEXT.md` and the notifications plan remain outside these commits. Push is
pending exact-snapshot verification: the normal pre-push command in the working
checkout fails on the 19 unrelated formatting paths described above. No check
was bypassed and no push or merge has occurred at this checkpoint.

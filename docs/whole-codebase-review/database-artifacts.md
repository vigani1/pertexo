# Database artifact metadata, uploads and lifecycle locking

Date: 2026-09-12. Primary reviewer fully read all 15 files below and ADR 035.
Six unit/static suites passed (20 tests, 632 ms). Two source-only probes used
injected clients and no network: hostile unlock rejection skipped client release;
abort during upload verification still permitted an available-state update.
Integration/prior-head suites were read, not run. Production migration SQL stays
in its separately tracked review scope.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/artifact-upload-contract.ts` | KEEP typed boundaries; REFACTOR/TEST WQ-176/177 | Normalizes nested actor/identity, rejects tenant mismatch, validates HTTP-safe media metadata and maps database rows. Metadata primitives duplicate worker-artifact rules; keep actor passthrough intentional. |
| `packages/database/src/execution/artifact-upload.ts` | KEEP atomic quota/verification phases; FIX WQ-175; REFACTOR WQ-176 | Actor-scoped idempotency and database capacity remain atomic. Lifecycle lock excludes physical cleanup across external verification without holding a transaction; second authority/metadata check is required. Signal is absent from nested transactions. |
| `packages/database/src/execution/artifacts.ts` | KEEP lifecycle guards; CONDITIONAL WQ-176; TEST WQ-177 | Exact identity/key/metadata, row locks, database-time expiry, deterministic due ordering and idempotent terminal states are coherent. Bounded per-row batch updates may be grouped only with preserved transition/counter semantics. |
| `packages/database/src/lifecycle/retention-transaction.ts` | KEEP lock/permit ownership; FIX WQ-174; TEST WQ-177 | Reserves pool capacity, handles late checkout after abort and destroys lock waiters. Hostile unlock error inspection can skip release. Do not destroy the exclusion lock early while external destructive work remains active. |
| `packages/database/test/artifact-upload-contract.test.ts` | KEEP media regression; TEST WQ-177 | Seven unsafe/normalized media cases cover a real shared boundary; add identity, numeric/date mapping and input bounds independently. |
| `packages/database/test/artifact-upload-runtime.test.ts` | KEEP; TEST WQ-174/175/177 | Four tests prove minimum pool size, permit reservation, late checkout cleanup and abort during lock acquisition. Missing work-phase cancellation, failed unlock disposal and combined failure cases. |
| `packages/database/test/artifacts-validation.test.ts` | KEEP; TEST WQ-177 | Four bad media cases explicitly assert no insert; extend valid boundary/lifecycle metadata cases without pretending these cover all artifact operations. |
| `packages/database/test/artifacts.integration.test.ts` | KEEP domain evidence; fixture TEST/FIX WQ-177 | Real RLS/immutable grants, exact replay, capacity grouping, expiry and disjoint claims are valuable. Eager runtime/shared migration and persisted random rows need owned fixtures; parallel claims do not force lock overlap. |
| `packages/database/test/artifact-upload.integration.test.ts` | KEEP authority/quota proof; fixture TEST/FIX WQ-177 | Exact retry, quota contention/rollback, active actor/workspace roles, expiry and counter release are meaningful. Mixed cases can be clearer, identity rows persist and cleanup/clock assertions need stronger ownership/evidence. |
| `packages/database/test/artifact-finalization-retention-deadline-migration.test.ts` | KEEP static guard | Two source checks preserve narrow expiry grant and user-upload backfill intent; prior-head integration is the behavioral evidence. |
| `packages/database/test/artifact-media-type-http-safety-migration.test.ts` | KEEP static guard | Two tests guard replacement/validation and exact HTTP field-value range; no runtime permission claim follows from text matching. |
| `packages/database/test/expired-artifact-upload-retention-migration.test.ts` | KEEP; TEST WQ-177 | Guards pending/deleting unlinked upload cleanup and retry syntax. Actual late verification/cleanup race belongs to runtime integration. |
| `packages/database/test/artifact-finalization-retention-deadline-migration.integration.test.ts` | KEEP strong upgrade proof; TEST WQ-177 | Disposable prior-head DB checks FORCE RLS across two workspaces, preserves long/pending/unrelated deadlines and verifies changed versus unchanged timestamps. Exact remaining migration suffix needs one maintained expected-head mechanism. |
| `packages/database/test/artifact-media-type-http-safety-migration.integration.test.ts` | KEEP strong upgrade proof; fixture TEST WQ-177 | Unsafe legacy row blocks migration; controlled correction permits upgrade; new constraint rejects unsafe data independently of triggers. Disables user triggers only in owned fixture transactions, not as production repair guidance. |
| `packages/database/test/support/artifact-migration-fixture.ts` | KEEP | Two small functions centralize role configuration and prior-head copies. Filename filtering and lexical cutoff fit fixed-width migration naming; caller owns isolated destination and cleanup. No need for a generic migration-test framework. |

## WQ-174 — never let unlock-error inspection bypass client disposal

P2 FIX/TEST. retention-transaction.ts:241–251 tests unlockError instanceof Error
before calling client.release. A Proxy rejection with a throwing getPrototypeOf
trap caused a secondary inspection Error and zero release calls in the actual
source helper. The finally returned the pool permit, so later work can proceed
while the original checked-out connection remains undisposed. Ordinary pg errors
are Error objects; this injected unknown-rejection boundary is not a claim of a
normal PostgreSQL incident.

Make error normalization nonthrowing and guarantee one client release/disposal
attempt independent of diagnostics or unknown-value classification. If unlock
failed, dispose the client even when the rejection is undefined, a primitive or
hostile object. Preserve operation and unlock causes when both failed; don't let
secondary classification erase them. Apply the same safe normalization discipline
to throwableError, abort reason handling and late-acquisition cleanup. Retain
idempotent permit release and late-checkout release after cancellation.

Test operation failure, unlock false/no-row/rejection, both failures, hostile
proxy, primitive/undefined reasons, synchronous release failure, and a subsequent
operation that proves capacity was returned. Assert callback invocation and
lock/unlock/release counts, disposal flag and original cause identity. This must
not be a broad error-hierarchy rewrite.

## WQ-175 — propagate finalization cancellation through short database phases

P2 FIX/TEST. artifact-upload.ts:322–357 passes signal to the lifecycle lock, but
readUploadArtifact and completeUploadFinalization omit transaction options.
The lock helper removes its abort listener once acquired, intentionally retaining
exclusion while work runs. After verifyUpload resolves, finalization calls the
second transaction without checking or forwarding signal. An injected callback
that aborted then resolved produced status=available, aborted=true and an update
executed after abort through the actual database source.

Check the existing signal after external verification and forward it into both
short tenant transactions, using their real cancellation/disposal semantics. Do
not release the session exclusion lock merely because a caller stopped waiting
while object verification/copy might still complete. Verification must settle or
be safely canceled before cleanup can race it. Preserve available replay without
reverification, late expiry rejection, post-verification authorization and exact
metadata checks. A commit already acknowledged/uncertain must not be claimed to
have rolled back solely because the HTTP request disconnected.

Add abort before permit/checkout, during first read, during object verification,
immediately after verification, during finalization update and around COMMIT.
Assert no new finalization starts after an observed abort, correct provider work
settlement, no leaked lock/client/permit, and eventual retention of pending bytes
without early capacity release. Integrate with WQ-061 API authorization error
mapping; that distinct error remains distinguishable from provider corruption.

## WQ-176 — clarify artifact phases while retaining two-phase revalidation

P2/P3 REFACTOR/CONDITIONAL. Metadata primitives (byte bound, HTTP-safe media type,
SHA-256) duplicate across artifact-upload-contract.ts:9–24 and artifacts.ts:36–50.
A private artifact-metadata contract can align these two database writers without
merging their public APIs or importing API-layer schemas into database code.
Keep API-generated identity/purpose/deadlines distinct from execution/preview
metadata whose retention is owner-bound. SQL and object-store constraints still
need independent parity tests, not runtime imports of arbitrary package internals.

Finalization currently repeats expected metadata/status checks before and after
verification. Retain both: the first avoids needless storage work; the second
rechecks mutable authorization/lifecycle before commit. Name a private exact
metadata predicate/guard and pass a stable normalized identity through phases if
that improves readability. Do not collapse them into one preflight check or wrap
object verification in a transaction. The local Date.now expiry check is only a
preflight; PostgreSQL clock_timestamp remains authority. Qualify clock-skew
behavior before retaining a preflight that could reject before database expiry.

beginUpload mixes access, idempotency claim, artifact reservation and completion;
small private phase helpers can make that sequence visible, but quota still
belongs to the database trigger and one transaction. Compute the key digest once
per request rather than at three SQL bindings if touching this code. Treat the
quota error inspector as an unknown-error seam: code/detail access can throw, so
add guarded classification tests without changing its stable public quota code.

artifacts.ts:307–351 selects at most 100 due rows then updates each separately.
This is bounded, correct lock ownership, not an unbounded N+1 defect. A single
UPDATE ... FROM selected rows is conditional on measured benefit and equivalent
trigger/capacity behavior, deterministic returned order and skip-locked semantics.
Keep one-row idempotent deletion transitions and exact failure outcomes. Capacity
observations are metrics, not admission authority; don't substitute them for the
capacity ledger or cache them as quota truth. Execution byte aggregates are two
statements on one transaction client, not actual parallel queries; document
snapshot expectations before treating their combination as atomic inventory.

## WQ-177 — complete artifact boundary, ownership and concurrency evidence

P2 TEST/fixture FIX. Add independent normalization tests for actor/route tenant
mismatch, role-context passthrough, idempotency key delimiters/bounds, byte limits,
hash/key format, malformed persisted rows, unsafe integers and valid dates. Keep
raw pg artifact projection parsing separate from trusted Drizzle row types.
Test empty/nonempty status aggregates, overflow rejection, missing rows and
event/checkpoint storage observations. Add exact finalized replay and deletion
transition/invalid-state matrices, preview-owner link rollback and late expiry.

Runtime permit tests should cover max>2, FIFO handoff, abort while queued, multiple
aborted waiters, failed checkout, failed lock, acquisition/abort race, combined
work/unlock failure and return of permits. A queued aborted waiter remains stored
until permit release; qualify queue growth under a stalled holder before adding
a separate bound or cancellation-removal mechanism. Do not change admission
fairness or unlock while destructive work is in flight just to shorten a test.
Protect deferred milestones in finally and observe promises immediately.

artifacts.integration.test.ts creates a runtime and migrates the configured
database, then leaves random artifact/capacity rows behind. Upload integration
cleans artifact/idempotency/capacity rows for its workspace but leaves users,
workspaces/memberships and their dependent creation state. Prefer the existing
disposable database fixture; retain role separation and failure-safe teardown.
Pool acquisition before try and sequential closes need the same ownership
discipline as WQ-170. Workspace-scoped cleanup is narrower than global TRUNCATE,
but it is not complete fixture disposal.

The pending-deadline test says database clock but compares against Date.now with
a five-second tolerance. Measure lower/upper database timestamps around insertion
or compare persisted database-generated values, not client clock agreement.
The four-row Promise.all claim test proves disjoint output, not forced contention:
hold one claim transaction, observe the second skipping its locks, then release.
Likewise preserve existing quota outcomes while adding a coordinated race where
needed; don't confuse probabilistic scheduling with a lock-order proof.

Keep the prior-head upgrade suites: they prove more than regex assertions. Use
one verified current-head suffix expectation when adding future migrations, while
preserving the exact prior cutoff. In media upgrade teardown, an owner.end error
must not skip temporary directory cleanup; attempt both and report failures.
User-trigger disable/restore and NO FORCE RLS fixture steps stay inside owned
transactions and must never be presented as runtime authority or automatic
production data repair.

Implementation order: WQ-174/175 regression fixes; fixture/cancellation evidence;
shared metadata and private phase cleanup; conditional batch optimization only
after measurement and counter/retention equivalence tests.

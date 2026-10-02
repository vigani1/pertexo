# F07 — Folders, tags, favorites and workspace discovery

Status: ADR064/contract and qualified F06 handoff accepted; persistent continuation
authorized on allocated exact integration base; implementation/qualification open.
Backend and frontend are implemented with local slice evidence; whole-feature
independent review, final clean-source owned qualification and release remain open.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Metadata backend + frontend. Relative size: **M**, not a calendar estimate.

## Outcome

Teams can find and organize many workflows without mistaking folder placement for authorization.

## Current implementation and evidence

Workspace workflow lists and search, archive/restore and activation exist. No complete tags/folders/favorites product was established by this inventory.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/src/features/workflows](../../apps/web/src/features/workflows)
- [apps/api/src/workflow-authoring](../../apps/api/src/workflow-authoring)
- [docs/adr/034-workflow-archive-restore-and-activation.md](../../docs/adr/034-workflow-archive-restore-and-activation.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; implement only organization actions not already present.

Folders are organization only in V1, not permission inheritance. Decide tag normalization and deletion behavior.

The primary accepted [ADR064](../adr/064-workflow-organization-metadata.md) and
the [concrete organization contract](07-organization-contract-proposal.md) after
full exact-source review at `a0508cd0` on 2026-10-02. It specifies tags/private
favorites first, authoritative bounded discovery, revision/replay/privacy,
hold-aware departure, bounded tag deletion and archived cleanup, shared lock
order, signed cursor integrity and compatible reader/writer rollback. Folders
and general bulk are required later slices, not omitted from F07 completion.
Folder name/sibling uniqueness and command schemas need a reviewed follow-on.
A [concrete folder/general-bulk proposal](07-folders-bulk-follow-on-proposal.md)
has received primary full-source acceptance of folder policy and its concrete
whole-parent batch identity guard. Additive folder persistence and batch admission
are locally qualified in owned disposable databases, with folder/bulk HTTP now
registered and qualified below; browser behavior remains open. Release-owner global reservation/base audit allocates
additive migration 0135 exclusively to this follow-on, preserving 0134 unchanged.
Migration 0134 is allocated exclusively to F07 against release-owner verified
base `936612f26567f760c83e41c13e4c7fc7b620e69f`, whose tree is identical to accepted
F06 `eed68cd6`. The draft schema has been installed only in disposable owned
qualification databases; no persistent deployment or writer enablement occurred.

Continuation authorized by primary final source review on 2026-10-02: F06
candidate `eed68cd67b45280db3951981da7e29b3726e06c7` is accepted and its release
handoff is owned by the release chat. That reviewed foundation is integrated
additively in this isolated F07 worktree, preserving accepted planning commit
`342239d8` and all F06 features/fixes. No history rewrite or mutation of the F06
checkout. Contracts/model/frontend preparation can proceed; persistent SQL must
use the release owner's subsequently verified exact locally qualified integration
base and migration allocation, not stale inventory `1433780b`. That reconciliation
is complete and integrated additively by normal merge. Hosted CI is not a
prerequisite to that local base decision. Folders and general bulk remain required
F07 acceptance scope; tags/favorites slice 1 is not completion of the feature.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Workflow-authoring metadata/persistence/contracts and web workflows; favorites have user ownership.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

Preparation inventory identifies two integration constraints: owner/admin tag
vocabulary uses an organization-specific role check, not a global broadening of
the existing owner-only `workspace:manage` capability. Organization cache keys
use a sibling feature prefix beneath the existing identity/workspace scope, not
legacy summary-list keys or the F06 portability lifetime prefix. This preserves
strict cached summary decoding and prevents organization-specific denials from
discarding unrelated portability recovery. Targeted rename/archive/organization
invalidation must include organized lists; root identity/workspace cancellation
and genuine authority loss remain fenced. Unsupported readers return sanitized
unavailable, never fabricated empty metadata.

## Frontend work

Bounded search/filter URL state, tags and favorites first; folder navigation later if needed, keyboard actions and explicit bulk outcomes.

## Backend work

Workspace-owned metadata and indexes, user-specific favorites, bounded folder depth and move-cycle checks. Reuse existing list/search owner; no external search cluster without measured need.

## Delivery slices

1. Select tags/favorites semantics and add metadata commands/read projections.
2. Deliver filters and consistent list/card navigation.
3. Add folder moves and bounded bulk actions; test concurrent rename/move/archive.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

No cross-workspace moves, no folder cycles, query bounds, favorite privacy, stale move conflicts, accessible navigation and preserved filters.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

A second workspace permission model, unbounded recursive folders or replacing existing search.

## Rollout and rollback

Hide new organization controls without losing workflow identities or archive states; additive metadata stays readable.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents workflow tags/favorites; Make documents scenario organization. Exact UX need not match either. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md); [Make scenario capabilities](https://help.make.com/scenarios).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Slice-1 product choices resolved; necessary ADR accepted. Folder-specific
      name/uniqueness/command decisions remain required before its later slice.
- [x] Slice-1 contracts and failure/security model reviewed; concrete folder/bulk
      implementation reviews and all execution evidence remain open.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: source inventory `1433780b`, proposed contract `dbe5a0a6`, concrete
ADR/contract `a0508cd0` accepted by primary exact-source review. Documentation
checks pass (21 tests/451 links at that draft). This is design evidence only:
no F07 persistent behavior, live journey, independent implementation review or
release is complete. Existing foundations are not completion of this increment.

Implementation foundation `5d6df9b4`: strict browser-safe organization command,
metadata and explicit projection schemas; canonical ASCII/U+0020 tag keys,
ordered bounded cleanup and literal UTF-8 query bounds. Contracts build/typecheck,
203 tests, unchanged generated transport artifacts and architecture/complexity/
duplication checks pass. These are primitives, not registered organization HTTP
commands or installed database behavior.

Implementation foundation `71a7676c`: signed organization cursor helper and
dedicated optional API key parser; version-1 fixed-order bounded payload,
HMAC-SHA256, 15-minute
expiry, exact timestamp/UUID position and scope/filter/order binding. Stable
canonical 32-byte base64 configuration rejects direct/previous identity key reuse;
there is no fallback or reader/writer enablement. Runtime wiring remains open.
The API dependency build, API strict typecheck/build, 1,982 API unit tests
(including 52 cursor and 18 key-configuration cases), narrow lint/format checks,
19 architecture tests, complexity ratchet and eight duplication-policy tests
pass; no quality baseline changed. Documentation checks pass (21 tests/456 links).
The [persistence implementation constraints](07-organization-persistence-design.md)
record the primary-accepted membership-generation and private held-evidence
approach before SQL, including explicit hold/lock/purge proof obligations.

The primary accepted a pre-favorite-helper correction: an absence expectation is
a bounded authenticated generation-bound `absent.v1` read token, not a timeless
`absent` literal. A command never delivered before departure has no receipt;
the token must still reject that old request after rejoin. ADR064 and the concrete
contract now specify the opaque HMAC wire, 24-hour TTL, five-second issuance clock
skew and mandatory receipt-first recovery before expiry/rotation verification.
The corrected browser-safe schemas pass 204 contract tests, build/typecheck and
narrow lint; real authentication, first-delivery/replay and database races remain
unimplemented/unqualified at that contract checkpoint.

Implementation foundation `dc16aadb`: authenticated generation-bound absence
token codec, fixed subkey and JSON order, canonical bounded opaque wire and generic
errors. Its 41 focused cases and full API 2,023 tests/147 files, strict build and
typecheck pass. This is not receipt-first HTTP/database integration proof.
Approved F06 CI-only descendant `80a439ad` is integrated additively by normal
merge `807a07e7`; 77 harness/policy Node tests and 27 actual CI policy checks pass.
Those checks are not a fresh F06 live qualification run on F07 source.

Database foundation: additive 0134, registration and exact readiness,
workspace-first author locks, lifecycle coordination and separately transacted
bounded cleanup have two read-only review axes with no remaining actionable
findings. Review corrected maintenance index seeks and added helper return/argument
ABI pins before final reruns. Fresh owned PostgreSQL qualification
passes 28 organization SQL tests (five observed-lock races, privacy, quotas,
hold-aware cleanup and bounded nine-relation purge pages), 29 exact-readiness tests
(27 deliberate catalog/ACL/helper/trigger/return-ABI drift denials), a real
EXPLAIN ANALYZE test with 5,000 current bookmarks and future receipts (indexed
expiry and generation ranges without planner overrides), and five existing live
lifecycle cases. Eight narrow suites pass 67 tests including migration regressions.
Database unit suite passes 961 tests, build/typecheck and schema ownership accounting
(119 tables: 77 typed, 42 raw SQL); architecture, complexity and duplication checks
pass without quality-ratchet changes. These runs use dynamically bound services
in task-owned project `pertexo-f07-c366649bac5e72a163344781`; disposable databases
are ownership-rechecked and dropped without force. Migration installation is
qualification only, not rollout. HTTP MAC verification, actual invitation rejoin,
full external-ledger deletion, browser journeys and later folder/bulk slices remain
open. Privileged fixture projections do not establish those product flows.
That database foundation's SQL/readiness sources are pinned by SHA-256
`ff632b94a30c06c1fbb0af4bb1425bdf9f7b3fc659f7cbf978218cd22b766416` /
`ec145e5188fc377cf9d68e73bcd0881a6c6f0f101aeaccd7a0a21250e75d1de0`.
Reusing the established independently validated migration-history fixture removes
a newly exposed copied-history clone; the unchanged duplication ratchet passes
at 10 test groups/285 duplicated lines. The affected published-repair and two
control-ledger suites pass 11 real PostgreSQL tests after that focused refactor.

HTTP routes and separate purpose-bound UUID-page continuation were accepted by
primary and recorded before endpoint code in `8f22b73f`. Additive readiness repair
`a63cd61e` integrates release-owner qualified `cbcfdfb5`: universal exact
metadata/body/ACL pins remain, while only actual API/worker database identities
invoke the separate confined inventory witness on the validated connection.
F07 migration head 0134 and its exact organization catalog pins are preserved.
On this integration, 21 serving-readiness unit cases and 32 owned PostgreSQL
readiness cases pass, including actual dispatcher without helper EXECUTE and
organization catalog-drift denials. These are fresh local qualification results,
not relabeled release evidence.

Private favorite adapter and application MAC authority: 16 transaction-protocol
unit cases, two actual-codec authority cases and eight owned PostgreSQL/application
composition cases pass. The live cases cover viewer/archived access, strict private
output, exact recovery before rotated MAC authority/disabled writer, changed-body
conflict, invalid-MAC receipt rollback, concurrent absence CAS, departure/rejoin
generation fencing and SQL rejection of valid-MAC expired/future timestamps.
Borrowed-runtime lifecycle is verified. Each read/write owns one tenant transaction;
transport callers cannot provide generation/proof selectors. The integrated unit
suites pass 986 database and 2,074 API tests. No new dependency or rollout is added.
This is not HTTP/session/CSRF, actual invitation, restart/browser or full F07
acceptance evidence; endpoints, filtered projections and folder/general-bulk slices
remain open. Writer remains default-off outside disposable qualification fixtures.

The separate UUID-page cursor primitive covers vocabulary and owner/admin
assignment discovery with distinct purpose, workspace/actor/selected-tag binding,
fixed canonical field order, derived HMAC subkey, 900-second TTL and bounded wire.
Its 49 cases, 52 existing workflow-cursor cases and 21 shared byte-envelope/clock
cases pass (122 total). A narrow low-level extraction preserves the existing
workflow cursor's exact wire vectors and separate semantic schemas while reducing
source duplication to 20 groups/330 lines; the test baseline remains 10 groups/
285 lines. No quality baseline changed. This does not establish endpoint routing,
current-authority page reads or real discovery pagination yet.
Final root integration rerun passes all 2,095 API unit tests/150 files, strict
API typecheck/build, architecture (19 tests), complexity, unchanged duplication
ratchets and documentation checks (21 tests/456 links). The eight actual favorite
MAC/PostgreSQL composition cases pass again after the cursor refactor.

Tag database adapter: bounded UUID-ascending vocabulary pages, owner/admin
assignment discovery including archived workflows, canonical vocabulary commands,
editor replacement and independent admin cleanup detachment now call the accepted
0134 helpers through one scoped transaction per command. Authority uses the same
explicit workspace/actor/member lock order as existing authoring writes; a narrow
extraction preserves those write queries and their role policy. Assignment tag
visibility and bounded rows use one statement snapshot, without granting API tag
UPDATE or helper EXECUTE. Seven new owned PostgreSQL adapter cases plus 28 existing
organization SQL and five existing lifecycle cases pass (40 total); the 986
database unit cases, strict build/typecheck and scoped lint pass. Eight actual
application favorite MAC/PostgreSQL cases pass after shared error extraction.
Source/test duplication remains 20 groups/330 lines and 10 groups/285 lines with
the unchanged ratchets. This is not signed HTTP discovery, live routing, bulk
transport recovery or browser proof. Unknown/foreign workflow-list tag-filter
empty-page behavior is qualified by the subsequent filtered-reader slice below.

Endpoint contracts now describe the eight accepted tag/favorite operations,
canonical GET includes, projected/default list union, strict bounded UUID pages
and ordered cleanup outcomes. Seven bounded organization problem codes are
registered with the accepted 409/503 distinction. Existing strict component
schemas and concurrency problem descriptors remain unchanged; unrelated generated
artifacts change only by the additive problem-code enum entries. All 217 contract
tests/30 files, generated-artifact/OpenAPI checks, build/typecheck and 2,095 API
unit regressions pass. The existing identity-workspace OpenAPI 2XX warning remains.
Dependency inventory passes after replacing the obsolete two-shape private GET
manifest with the unified four-shape contract, using equivalent named schema
clones rather than duplicate exports, and keeping the internal catalog witness
private. The SQL catalog expression/digest is unchanged; all 29 exact organization
readiness tests pass again. No endpoint/controller or organization reader is
registered by this contract checkpoint; session/CSRF, routing, restart and browser
proof remain open. Filtered pagination is qualified separately below.

Organization database reader: one scoped generation/clock read and one bounded
SQL projection now intersect literal case-sensitive name search, lifecycle,
workspace-scoped tag and current-actor favorites before keyset pagination. Only
U+0020 is trimmed; the 128-byte UTF-8 search limit and escaped percent, underscore
and backslash preserve literal matching. Canonical authoring workflow fields use
the existing row mapper; metadata never returns actor/generation/evidence fields.
Default lifecycle selection remains `all`, organization writes preserve workflow
timestamps, and archived favorites remain readable. Six new owned PostgreSQL
cases plus all seven tag-adapter cases pass, including unknown/foreign tag empty
pages, current authority on continuation and compatible reads while writers are
off. The 16 favorite protocol tests still pass after sharing absence metadata
logic. Nine actual application MAC/PostgreSQL cases pass, including distinct
per-workflow list revisions, rejection on another workflow and acceptance by the
favorite command. The SQL-reader fixture deliberately uses a synthetic authority;
only the application integration suite qualifies actual MAC composition. These
are database/public-adapter proofs, not registered HTTP or browser behavior.

Organization API failures now flow through the existing authoring error boundary:
all six tag conflict kinds, favorite conflict, unavailable and invalid requests
map to the accepted fixed-detail problem codes without private revision/proof
properties. The 29 focused cases exercise both the leaf and composed mapper;
all 15 existing mapper cases still pass. Existing portability/origin mappings
were extracted unchanged to their own leaf so the central error function gets
smaller rather than worsening its complexity hotspot. API build/typecheck,
scoped lint, architecture, complexity and unchanged duplication ratchets pass.
This connects error translation only, not runtime routes or persistence ports.

Organization application interface: strict command and read use cases now own
transport schemas, organization-specific owner/admin checks, trusted actor scope,
cancellation, normalized filter identity and purpose-bound signed continuations.
Fifty command and 14 read cases pass. The opt-in read path preserves strict
summary-only responses without `include=organization`; changed filters/order/
projection/actor invalidate continuations, while normalized equivalent queries
and a changed page size retain them. Combined origin projections call the existing
compatible origin owner, never a raw join or fabricated null. Every page is
authorized and database adapters remain the transactional current-authority owner.
These focused use-case tests are not live HTTP or browser qualification.

Individual organization HTTP slice: seven tag/favorite operations and opt-in
workflow list/get projections are registered through the existing Nest feature
module, session/workspace/CSRF guards, mutation rate policy, cancellation and
private no-store headers. A dedicated metadata runtime validates the configured
organization root, composes actual MAC/cursor/database capabilities and owns
their shutdown; missing configuration is sanitized unavailable, not synthetic
empty metadata. Existing input-case ownership/test opt-in behavior is preserved;
the core runtime hotspot decreases from 177 lines/39 branches to 174/34.
Twenty-seven Nest/Fastify controller cases use fake session admission/persistence
and are explicitly not live-session/SQL proof; five lifecycle/construction cases
send no database query. Separately, six fresh F07-owned real-session, compiled-API
and PostgreSQL HTTP cases pass: session/CSRF/strict private-body rejection, actual
MAC failure with same-key corrected retry, exact tag recovery/stale conflicts,
canonical filtered keyset pages, cursor scope/purpose binding, viewer privacy and
current role/suspension fences, stable rename and bounded archived deletion,
combined compatible origin projection, and writer-OFF reads/replays/new-write
denial. Membership rows are privileged fixture setup, not invitation transport
qualification. Nine actual application MAC/public database cases still pass.
The live literal-query regression also found PostgreSQL's invalid NUL text
parameter boundary. The reader now returns an empty page for this valid literal
query, since stored PostgreSQL names cannot contain NUL; owned reader and actual
HTTP regressions pass without narrowing the accepted query contract.
All 2,220 API unit cases/155 files, build/typecheck, scoped lint, architecture,
dependency inventory, complexity and unchanged duplication ratchets pass.
At this individual-HTTP checkpoint, tag cleanup and general bulk were not yet
registered/qualified: their parent-admission guard required additive 0135. Restart,
real browser behavior, rollout and whole-feature acceptance remain open.

Folder/batch database foundation (`f93760e`): 87 owned PostgreSQL cases pass
with no skips across folder/batch behavior (13), organization SQL (28), scoped
reader (7), readiness/upgrade drift (36), and public folder/batch adapters (3).
The adapter tests exercise real committed admission, item key derivation,
replacement/cleanup and placement preservation; their 45 focused unit cases
separately cover strict mapping, cancellation and lease/error behavior.
The tag and folder adapters share only the existing leased tenant-transaction
boundary; command SQL, parsing and error semantics retain their owners. The
source and test duplication baselines are unchanged.
Parent admission records a private
top-level transaction ID; items reject admission created in their own transaction,
including a released savepoint. Changed ordered selections, operations and expected
revisions conflict before items; exact retries still recheck current authority.
The populated 0134 upgrade preserves existing receipts and organization revisions
and resets organization writers OFF. Folder placement shares organization CAS,
preserves workflow timestamps, and participates in bounded leaf-first purge and
legal-hold retention. Exact folder/root filters run before keyset pagination and
are bound into signed continuation identity. Existing compiled tag/favorite HTTP
and actual MAC/public-adapter qualification passes 15 cases against the draft.
The subsequent local exact-head rerun records 94/94 cases across six files,
including all seven existing tag adapter integrations, with zero skips. Its
external receipt is
`/Users/vigan/.codex/evidence/pertexo-f07-2026-10-02/folders-f93760e/receipt.md`.
This is local foundation evidence, not a hosted release receipt, frozen old-image
qualification, process restart, folder/bulk HTTP registration, or browser proof.
Those gates and whole-feature acceptance remain open.

Folder/bulk HTTP slice: all eight folder/placement, general-bulk and tag-cleanup
routes now use the configured metadata runtime, current session/workspace guards,
CSRF, mutation rate policy and private no-store responses. Individual placement
looks up editor authority afresh rather than reusing the read guard's capability;
SQL owns the current archived-workflow role fence. Parent admission commits before
ordered serial item transactions, each with fresh authorization. A SQL visibility
denial triggers a fresh authority check; authority loss produces `forbidden` and
stops remaining targets as `not_processed`, without retained item revisions.
No client parent hash, item key or proof flag is accepted. Recovery retains the
full ordered request and key; historical receipts do not become current metadata.

Sixty-two folder use-case, 30 batch use-case and 47 controlled Nest/Fastify
controller cases pass. The controller suite registers old and new controllers
to cover static routing collisions, but its fake session/persistence is not live
authority proof. Separately, five new real-session/compiled API/PostgreSQL cases
qualify folder CRUD and exact filtering, placement CAS, ordered partial bulk and
changed/disjoint full-parent conflicts, cleanup's shared namespace and retained
archived placement, builder archived replay fences, and writer-OFF reads/recovery
versus new admission. All six prior organization HTTP and nine actual application
MAC/public-adapter cases pass too: 20/20 across three files with zero skips.
Application-owned rate counters are isolated per HTTP suite, retaining the real
per-origin limit rather than weakening production policy.

The archived replay regression also exercised the complete mapper/filter chain:
generic organization lifecycle conflicts now carry a private internal discriminator
so the shared filter does not demand or fabricate lifecycle CAS revision metadata.
Existing lifecycle/name commands still validate their typed revision extensions;
177 mapper/filter cases and all 2,380 API unit cases/158 files pass. The generic
organization contract is unchanged, and the internal discriminator is never on
the wire. Invalid route workspace UUIDs now fail as `request.invalid` before actor
construction, with a focused guard regression. API build/typecheck, scoped
lint/format, architecture, complexity and unchanged duplication ratchets pass.
The folder/bulk HTTP slice is locally verified, not hosted, merged, rolled out,
process-restart-qualified or a real browser acceptance result. Whole F07 remains
open, including the user-facing organization controls and rollout gates.

Browser organization checkpoint: the workflow list now has bounded, server-side
literal name, tag, exact-folder/unfiled and private-favorite filters with preserved
URL state. Folder breadcrumbs, owner/admin vocabulary management, single and
explicit ordered bulk organization, bounded selected tag cleanup, and personal
favorites use current projections and fresh role checks. Organization query keys
remain separate from legacy summary and portability recovery keys. Uncertain
commands retain the full original key/body/order; retry never installs historical
metadata. Favorite recovery is owned by the list rather than a disappearing row.
Legacy create, rename, lifecycle, import, duplicate and publish invalidations also
refresh organized lists.

The normal browser build remains OFF. Only an explicitly attested owned loopback
qualification build substitutes its gate; the canonical production import and
scoped alias are aligned. Browser unit qualification passes 1,055/1,055 cases in
131 files with no skips; web lint/typecheck/build, architecture, dependency,
complexity and unchanged duplication checks pass. React Doctor remains 93/100
with two existing orchestration complexity warnings and no new owned-leaf
findings. The normal OFF build passes all 91 existing Playwright browser cases,
including Chromium and Firefox/WebKit smoke coverage; its mocked transport is
not live organization acceptance evidence.

Separately, one real browser/API/PostgreSQL owner journey passes ordinary
registration, mail verification, login and workspace/workflow creation, folder
hierarchy changes and nonempty-delete conflict, tags, placement/unfiling, private
favorite confirmation, combined filters and preserved navigation, explicitly
ordered bulk with a deliberately lost committed response and exact full-request
replay, and bounded cleanup. Fresh HTTP reads and privileged persisted
corroboration verify the results. Browser lifetime barriers complete before the
owned fixture is dropped. This first local journey used the working browser
checkpoint; exact committed-head rerun, role/archive/privacy and partial-outcome
browser matrices, process/OFF integration, independent whole-feature review and
release evidence remain open. No production enablement, push or F07 completion
is claimed.

Compiled process/OFF qualification: the frozen pre-organization API at
`936612f26567f760c83e41c13e4c7fc7b620e69f` refuses migrated 0135 before listening,
classified only by the exact migration-head readiness error. The compatible
compiled API at `74826ea1c5d2aa8c07d1d0c70edff1889a3fcf71` runs its complete
application/bootstrap/readiness path. Its production API, database, contracts,
package and lock sources are unchanged at browser checkpoint `9d945090`; this
is a scoped source-equivalence observation, not a rebuilt whole-tree artifact.
One real process case and five focused safety cases pass with no skips. An
explicit tenant-scoped lock proves the second workflow exists and is blocked;
the parent and first item are independently observed committed before SIGKILL.
A distinct restarted API replays the first item and freshly completes the second
under the unchanged full request/key, preserving folder, tag and private favorite.

A further compatible process with writers OFF retains current organization
reads and completed shared/private replay, rejects new folder/parent admission,
and cannot execute an admitted-only parent's new item. Frozen older contracts
strictly parse default legacy summary/list responses with unchanged workflow IDs.
Export, independent duplicate/import without inherited organization, and
archive/restore also pass. The optional 0134 compiled image was not separately
built. Existing hold/expired-receipt/bounded purge evidence remains in the owned
SQL suites rather than being relabeled as process evidence.

The new test-only owner reuses the established cutover resource helper: its
temporary database retains the historical `pertexo_test_f06_cutover_` name and
its Redis DB12 is initially empty and token-fenced. This is explicitly F07
evidence, not new F06 acceptance. Process-group shutdown must be confirmed before
database/Redis/artifact cleanup; barrier failures preserve resources. The final
run confirms zero connections, database removal and Redis DB12 empty after twelve
owned keys are removed. Ordinary shared services stay running. Production writers
remain disabled outside these owned fixtures. Whole-feature browser matrices,
independent review and release remain open.

Coverage reconciliation now passes the complete `pnpm test:coverage` command:
24 producer cohorts bind to candidate fingerprint
`sha256:732f85bf2dbe9f54325695e2ce63e66d7f9f5c382c7349d8f931b845bc22a69d`.
The strict selected-critical-module policy reports zero unreviewed branches and
the unchanged 391 reviewed obligations. This is coverage of its 231 selected
files, not a claim that every source file has complete coverage. Independent
source review confirms all six existing API bootstrap/cleanup exclusions retain
their meanings; their locators follow the additive runtime configuration lines.
The extracted UTF-8 helper retains its defensive obligation at its new source
location rather than deleting it. Two real-runtime composition cases cover the
new optional organization configuration arm. Dense canonical identifier ordering
now uses a shared ordinary comparison loop, with public-schema regression cases
for empty/singleton and malformed arrays; both outcomes are measured rather than
adding unreachable nullish-fallback exclusions. No thresholds or exclusion counts
were relaxed. Producer reports, the source witness and strict risk report are
preserved outside the checkout in the dated local F07 evidence directory.

Required F07 CI ownership is registered separately from accepted F06: the exact
four gates require database 95 (94 core cases plus the existing sparse-maintenance
EXPLAIN case), API 20, compiled process 6 and live browser 4, all with zero skips.
The shared evidence engine retains fresh exclusive reports, stable clean source,
owned process barriers, rechecked service attestation and actual report-byte hashes.
F06 commands and minimum-count behavior are unchanged. The F07 process gate pins
its compiled compatible artifact to the actual qualification HEAD, never a stale
source-equivalence claim. Required CI history, frozen dependency preparation,
normal build, Chromium installation, explicit owned role URLs including
maintenance, always-cleanup and complete strict report upload are policy checked.
Ordinary integration excludes exactly these dedicated opt-in suites, retaining
ordinary HTTP/lifecycle tests. Policy and evidence unit checks pass 67/67; lint,
format, complexity and unchanged duplication checks pass. This registers the lane;
it is not evidence that hosted CI has run or that the final clean-source local
four-gate qualification has completed.

The updated compiled-source checkpoint `a2a8172c` independently passes actual
restart/OFF qualification 6/6, including rebuilt contracts, with all process
barriers before zero-connection database removal and token-fenced Redis DB12
cleanup. The older 74826 observation remains historical, not evidence for later
contracts. An expanded role/archive/populated-OFF browser matrix locally passes
4/4 with zero skips after the startup/cleanup repair. Five default-discovery
unit regressions exercise occupied listeners, exited and live real children,
exit during pending readiness and every child cleanup attempt despite a rejected
browser proof. Each selected browser receipt requires exactly one expected
passing test, plus opened/disposed receipts. Viewer, builder and admin use ordinary
public registration/invitations/acceptance and isolated real API fixtures; canonical
worker delivery handler/store/envelope composition captures only external mail.
This is not a full worker/Redis dispatch claim. The matrix verifies private
favorite isolation, explicit ordered updated/conflict feedback, archived role
boundaries, archived placement/tag cleanup and restoration. A normal production
OFF build retains real folder/tag/favorite state with zero UI organization reads.
Public HTTP and persisted metadata corroborate each case. Final exact committed
source qualification and whole-feature independent review remain open.
Earlier failed matrix attempts preserved four databases and did not emit creation
witnesses sufficient for authorized automated recovery; they remain preserved.
The positively identified stale owned preview process was disposed through the
canonical group barrier. No unknown listener was killed, no broad database drop
occurred, and no missing failed raw report or creation witness is fabricated.

Whole-feature two-axis source review at `86e8a32a` found actionable frontend
issues, so F07 is not accepted. The specification axis identified unknown-command
abandonment through in-dialog refresh; the hook now refuses reset while pending
or unresolved, and refresh retains the entire frozen key/body/selection/revisions.
Favorite and partial-batch regressions explicitly refresh before exact retry;
definitive recovery alone permits a new intent. Forty-one focused cases and lint
pass. The standards axis identified ordinary read-denial cache retirement and
binding Weft validation/confirmation/name-label violations; those corrections and
their committed-delta review remain open. No backend/spec scope expansion or
additional actionable backend finding was reported by either axis.

The exact clean-source four-gate run at `86e8a32a` passes database 95, API 20 and
compiled process 6, but the browser gate fails one builder combined-filter URL
assertion (three of four cases pass). Its failed manifest and actual producer
reports are retained, not relabeled as acceptance. Filter navigation sequencing
and captured search state are under investigation; no timeout or guard is weakened.
The complete coverage command on this frozen checkpoint separately passes all 24
cohorts with zero unreviewed and the same 391 reviewed branches. Passing producer
coverage does not cancel the review findings or the failed whole browser gate.

The bounded Weft corrections now pass 18 focused manager/feedback regressions:
folder/tag forms use field-associated validation with first-invalid focus and
actual save/move/delete pending states; deletion uses the canonical confirmation
owner. Bounded assignment labels resolve at most fifty explicit loaded/selected
workflow IDs through current authorized projections, cache only names or null
under the organization scope, and show safe unavailable labels rather than UUIDs.
Resource-specific missing workflow labels return null without claiming authority;
401/403 still fence the scope. Selection order, exact frozen command bodies and
current revision checks are unchanged. Owned lint/format checks pass without
suppressions. React Doctor reports three manager control-flow maintainability
advisories, reviewed and retained honestly; no functional defect is asserted from
the score. Independent committed-delta review remains required.

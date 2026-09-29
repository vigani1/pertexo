# Workspace inbox notifications and live updates

Status: in progress under accepted [ADR054](adr/054-durable-workspace-inbox.md).
Created 2026-09-25. Contracts/database foundation is locally verified; no runtime
inbox or frontend is delivered. Earlier recommendations below are subordinate to
ADR054's accepted decisions, not claims of production readiness. In particular,
ADR054 governs atomic audience capture, composite recipient identity, current
eligibility/restoration, fixed source/evidence horizons and resumable read-all;
the generated foundation contract uses POST for single-read. Numerical budgets
remain unmeasured, and later runtime/read-all/SSE interfaces remain to be delivered.

## 1. Outcome and scope

Give people a durable, personal inbox for actionable workspace events, updated
while the app is open and recoverable after disconnects. Preserve the existing
architecture: PostgreSQL authority, existing outbox/BullMQ transport, NestJS
feature modules, browser-safe contracts and React feature ownership.

Distinguish three concepts:

- Run events/live status: existing execution truth and run SSE; remain in runs.
- External failure alerts: existing ADR 022 intent/delivery and destinations;
  remain independent. The Alerts page continues to configure these.
- Workspace inbox notification: a recipient's retained notice and read state.
  This new feature must not imply incident acknowledgment/resolution.

First slice: one inbox entry per eligible recipient per terminal failed,
timed-out or outcome-unknown run. No success, cancellation, individual step,
retry, queue progress or notification-delivery-failed notices. No historical
backfill. Replay is a new run and can produce a new notice; redelivery cannot.

Defer connection-health transitions until authoritative transition semantics
exist; do not infer them from a failed HTTP request. Also defer invitations,
account-security inbox events, subscriptions/preferences, grouping/digests,
mark-unread, dismissal, browser push, email expansion, mobile push and general
cross-workspace inbox. Existing security/invitation email remains unchanged.
No new package, WebSockets, generic event bus or notification framework.

## 2. Required architectural decision before code

Accepted ADR054 records durable workspace inbox projection, audience semantics,
per-recipient read state and SSE snapshot recovery. Its implementation acceptance
does not close load, live delivery or production gates.
Reference ADRs 003 (tenancy), 005 (outbox/inbox), 013 (retention), 022 (external
failure alerts), 039 (session authority), and current SSE contracts.

Repository inspection must identify the exact terminal transition, outbox
registry/dispatcher, consumer-readiness and persistence seams before changing
them. Do not reuse the external-alert consumer queue competitively: both
consumers need independent receipts/delivery, not one stealing the other's job.

## 3. Responsibilities and files

| Owner | Responsibility |
| --- | --- |
| `apps/api/src/notifications/` | Thin controllers, authorization, list/count/read use cases, SSE lifecycle, public projection and safe error mapping |
| `packages/database/` | Additive migration, recipient-scoped reads, transactions, RLS, projection receipts, revision/read state and retention integration |
| `packages/contracts/` | Versioned event envelopes, HTTP/SSE schemas and browser-safe schema export; generated OpenAPI and client updates |
| Existing coordinator/outbox | Atomically record identifier-only inbox source event alongside terminal run truth |
| Existing worker | Bounded, resumable, deduplicated recipient projection; existing worker configuration and telemetry |
| `apps/web/src/features/notifications/` | API/queries, stream hook, pure display model, inbox and bell components; deliberate `public.ts` |
| Existing workspace shell/routes | Mount one active-workspace inbox stream and compose the feature; no notification business logic |

Use existing modules/providers, database transaction helpers, audit conventions,
problem responses and test cohorts. Separate controllers, orchestration and
persistence; no SQL/provider calls in controllers. Do not create empty folders
or layers just to match a template. Read root/web instructions and relevant
NestJS, PostgreSQL, Node, TanStack and React skills when implementing each slice.

## 4. Audience and authorization

Recommended V1 audience: active owners, admins and operators with run-read
permission. Builders/viewers still have permitted run history; they are not
automatically subscribed to every failed run. Surface this policy in the UI.
No workflow-owner assumption: there is not necessarily a dedicated owner.

Capture eligible membership IDs/revisions when the projection first claims
the source event; this is explicitly projection-time, not failure-time,
membership. Persist the audience once, then page its processing. Retries must
not add newly joined members. Prevent an unbounded transaction for large teams.
Before each insert and every read/count/stream, require current active membership
and permission. Never accept a recipient ID supplied by the browser.

Membership removal/suspension, role loss, workspace deletion and logout must
stop future delivery and remove access to existing notices. Define the stream's
authorization recheck using the existing revocation policy; maximum 5 seconds
if no stricter existing policy applies. Do not claim instantaneous revocation.
Restore/reactivation exposes only that person's still-retained entries; no
backfill. Counts and lists must apply identical visibility filters.

RLS and grants must cover both workspace and recipient isolation. API identity
context and worker system context use existing separate roles. Cross-workspace,
cross-user IDs return the established non-disclosing not-found response.

## 5. Persistence and privacy

Logical records (final table names follow database conventions):

- Source event: version, source ID, workspace/run ID, terminal event sequence,
  safe terminal status and occurrence time; durable outbox reference.
- Projection receipt/audience: source identity, captured recipients, bounded
  progress/lease, retry and completion state.
- Inbox entry: ID, workspace, recipient, kind, source identity, occurrence time,
  creation time, safe typed target, nullable read timestamp, expiry timestamp.
- Recipient state: workspace+recipient key and monotonically increasing inbox
  revision. Increment transactionally for insertion/read/retention changes.

Unique source identity includes run ID and terminal event sequence; recipient
entry uniqueness adds recipient ID and kind. Changing external alert policy
must not create a second in-app notice. Use composite workspace foreign keys.
No raw provider errors, stack traces, run inputs/outputs, credentials, signed
URLs or arbitrary HTML in entries, queue messages or SSE. Titles use approved
templates and authorized metadata; missing/deleted sources get a safe fallback.

Indexes cover recipient+workspace+time+ID paging, unread counts and expiry.
Lists use bounded keyset pagination (default 25, max 100), deterministic order
and validated opaque cursors scoped to recipient/workspace/filter. All/unread
filters only in V1. Document moving-list behavior as new entries arrive.

Recommended retention: 30 days from creation for read and unread notices,
subject to ADR 013 legal holds/deletion requirements. Display the window.
Retention is batched; integrate with workspace/account purge and existing
maintenance, not a new ad hoc cron. Do not cascade away retained audit evidence.
Keep source deduplication receipts at least through the supported replay window;
purging an entry must never allow an old redelivery to resurrect it. Workers
discard source events beyond the explicit activation/expiry window safely.

## 6. Reliable production of notices

1. Terminal run transaction commits run truth and the inbox source outbox event.
   This must happen independently of whether an external destination is set.
2. Existing dispatcher transports identifiers through a separately versioned
   consumer contract. Consumers load authoritative state by those identifiers.
3. Worker captures the audience and projects bounded batches; recipient insert,
   dedupe receipt/progress and revision changes commit together.
4. A successful commit makes the notice readable even if live delivery fails.
5. Retry/recovery uses existing leases, backoff and poison-message handling;
   expose backlog and exhausted retries operationally without recursive notices.

Never send SSE, external mail or provider requests inside a database transaction.
Neither projection nor external-alert delivery changes the terminal run result.
No exactly-once transport claim: at-least-once transport plus database uniqueness
provides one visible entry per logical source and recipient.

## 7. HTTP contract

All routes below are proposed additions under
`/v1/workspaces/:workspaceId/notifications`:

| Method/path | Behavior |
| --- | --- |
| `GET /` | Page of entries, next cursor and observed inbox revision; `filter=all|unread`, limit/after |
| `GET /summary` | Exact authorized unread count and observed revision/time |
| `PUT /:notificationId/read` | Monotonic read acknowledgment, repeat-safe; preserve first read timestamp |
| `POST /read-all` | Read entries covered by a server-issued snapshot token, not notices arriving later |
| `GET /events` | Authorized SSE invalidation hints for this recipient/workspace |

List/summary return an opaque recipient-scoped read-all snapshot token backed by
a committed revision cut. Store an entry creation revision. Serialize creation
and read-all against the same recipient-state lock so a concurrent insert cannot
accidentally fall behind the cut. No timestamp-only cut or untrusted sequence.
Bound mark-all work; if supported scale requires batching, define an explicit
operation contract before shipping rather than silently partially marking it.

Mutation response returns authoritative read state/revision; normal HTTP uses
existing cookie sessions, CSRF, request IDs, schemas, rate limits and error
format. Read requests never mark entries read. Add endpoint cost/rate classes,
contract projections and import allowlists. Do not expose arbitrary redirect URLs.

## 8. Live transport: SSE, not WebSockets

SSE is a hint channel; PostgreSQL remains truth. V1 needs no new Redis Pub/Sub
dependency. Reuse the existing database-backed SSE polling/recheck facilities
where suitable: one shared bounded scheduler per API process for active
subscriptions, not an unbounded database loop per tab. Check recipient revisions
in batches with a default five-second interval, jitter and configured limits.
Share in-process reads for duplicate recipient/workspace subscriptions.

On connect send a ready/reset hint after authorization. A changed revision emits
`inbox.changed` with schema version and revision only. Browser refetches current
list/summary; no notification content, credentials or run payload crosses this
channel. It also refetches on reconnect/focus. Gaps and expired last-event IDs
mean reset/refetch, not pretending every event was replayed. Document that this
stream differs from resumable run-event history.

Native EventSource versus the existing fetch-SSE adapter is an implementation
choice constrained by session/error/retry requirements; reuse the existing
adapter if it satisfies them. No bearer tokens in query strings. Same-origin
cookie authentication; validate origin/cross-site requests under existing policy.
Check session expiry and membership throughout the stream, stop on revocation,
and clean listeners/timers/subscriptions on close, navigation and server drain.

Heartbeat default 15 seconds; disable proxy buffering/caching and configure idle
timeouts above heartbeat. Bounded write buffers, slow-client disconnects, per-user
and process connection caps. Clients back off with jitter on network/429/503;
no retry storm on 401/403. Visible offline/stale state, not a false zero count.

Redis Pub/Sub can later reduce latency across API instances, but is only a wake
hint: periodic revision checks and reconnect snapshots remain mandatory. Prove
multi-instance delivery and acceptable database load before enabling V1; if the
existing stream infrastructure cannot batch safely, resolve this in the ADR
before adding a second streaming subsystem.

## 9. Frontend behavior and consistent structure

Feature files: `notifications.api.ts`, `notifications.queries.ts`, a stream hook,
pure presentation helpers and small components for bell, list, row and states.
Add a lazy workspace notifications route and compact bell popover; both reuse
the same list/read logic. Preserve editor space: integrate into the existing
compact shell, not another persistent header or sidebar.

TanStack Query owns entries/counts; keys include account ID, workspace, filter
and paging inputs. Router owns route/filter. Local state owns popover and focus.
No Zustand notification store, mirrored unread counter or effects copying query
data into state. One stream owner per active workspace per tab, outside rows.
Cross-tab leader election is not required for V1; enforce connection budgets.

Register stream before initial fetch; buffer/coalesce hints during startup and
refetch once afterward to close fetch/subscribe races. Coalesce invalidations
while requests are active and schedule a trailing refresh. Avoid polling in
both Query and the stream hook. Visibility/focus recovery must catch up.

Use pessimistic read mutations initially: pending feedback, authoritative
response then invalidate affected lists/summary. No fragile optimistic count
subtraction across filters/tabs. Preserve list on mutation failure with retry.
Read-all uses the visible snapshot token; newly arriving notices remain unread.
Account/workspace changes abort old requests, close stream and prevent late
results/toasts from entering the new scope using existing identity fences.

Bell shows unread count (display 99+ if needed; exact count remains accessible).
Opening the bell does not mark all read. Clicking an entry marks that entry read
and opens its authorized run; acknowledging does not resolve the failure.
Missing/expired target shows a clear unavailable state. No automatic navigation.
No incoming-event toast in V1: durable badge/list avoids duplicate/multi-tab and
initial-backlog noise. Existing action toasts remain independent.

Use Weft tokens, existing Base UI primitives, shared pending/error/retry controls,
relative time helper and reduced-motion behavior. Keyboard navigation, focus
return, accessible unread labels and mobile scroll/viewport behavior are required.
Loading, empty, failed, stale and permission-denied states must be distinct.
Do not announce every stream heartbeat or every count change to screen readers.

## 10. Verification matrix and operational evidence

- Contracts: schemas, bounded inputs/cursors, generated OpenAPI, browser exports,
  predecessor event readers and unsupported-version handling.
- Real PostgreSQL: tenant/recipient isolation, uniqueness under concurrent
  redelivery, unread/count agreement, read-all vs insertion race, membership
  revocation, retention, deletion and receipt survival after entry expiry.
- Worker/queue: rollback before commit, crash after commit/before enqueue,
  enqueue-before-ack duplicate, mid-fanout crash, lease takeover, Redis outage,
  restart/replay, disabled external policy, poison event and large audience.
- Real API/SSE: authorization on connect and midstream, cookie expiry/logout,
  limits, slow clients, cleanup/drain, missed hint and reconnect snapshot,
  mark-read in another tab, two API processes and unavailable PostgreSQL.
- Frontend unit/component: keys, burst coalescing, read-all cut, mutation errors,
  startup race, account switch, no stale toasts/count, empty vs loading/error.
- Browser: desktop and 390px, keyboard/reduced motion, initial backlog, offline
  recovery, multiple tabs, deep link, deletion/role loss. Test against actual
  local API/database/worker as well as mocked boundaries. Trigger a controlled
  local run failure without sending external mail or calling paid providers.
- Regressions: run SSE, external failure-alert intent/delivery, existing failure
  policies, ordinary run execution and workspace deletion remain unchanged.

Measure terminal-commit-to-inbox latency, oldest pending source age, projection
failures/retries, dedupe hits, subscriber count, query cost, disconnect reasons
and stream lag. No recipient IDs as metric labels and no sensitive payload logs.
Initial local target: visible within 10 seconds under healthy declared load;
publish the tested load and hardware, not an unsupported production SLA.

## 11. Rollout and implementation order

1. Confirm recommended audience/retention/no-toast scope; inspect exact seams
   and write the ADR, contracts and additive migration. Review RLS/grants/indexes.
2. Implement durable terminal source, consumer and recipient persistence with
   real-service crash/dedupe tests. Deploy readers/consumers before producers;
   default producer flag off until readiness and migration are verified.
3. Implement HTTP list/summary/read/read-all and prove security/concurrency.
4. Implement plain frontend inbox/bell using HTTP. Verify complete behavior
   before adding live transport; no fake enabled buttons for absent endpoints.
5. Add SSE and query refresh, then multi-instance/reconnect/mobile proofs.
6. Run integrated regression/quality checks and controlled load rehearsal.
   Enable only for newly occurring events after the activation watermark.

Update this document with evidence at each slice. Do not mark the entire system
complete from unit or mocked browser tests. No production migration, services,
external mail, commits/push/merge or deployment are authorized by this plan.
Rollback disables new producers and UI/stream exposure; retain compatible
consumers to drain accepted work and retain additive data. Never roll back by
dropping populated tables or rewriting run history.

Completion means: one retained notice per eligible recipient for an actual local
run failure, correct private read state, authorized live updates and recovery,
green independent regression checks, and documented operational limits. Success
notifications, preferences and new source types require separate scoped slices.

### Foundation delivery evidence (2026-09-28/29)

[F03](feature-plans/03-workspace-notifications.md#foundation-evidence-2026-09-2829)
and ADR054 record the contracts/migration/schema foundation, which remained
uncommitted at the 2026-09-29 verification checkpoint, and its
accepted checks: 118 contract tests, 869 database unit/static tests and eight
real runtime-role PostgreSQL foundation cases after the reviewed fixture-only
correction. The earlier eight-failure setup run remains recorded; it reached no
inbox assertions. The corrected run's normal owned cleanup preserved the seven
baseline databases. No services were started/stopped or guards bypassed.

This closes only the foundation gate, not the complete lifecycle: source
production, projection, retention execution, operator recovery, HTTP, frontend,
read-all, SSE, integrated browser/multi-instance/load evidence and production
activation remain open. Existing run SSE/external alerts are not substitutes.

The foundation subsequently merged through PR115 at main
`e292c857152ec61b2995f6608239c668a66e22c6`; natural main CI 36495495693 and
CodeQL 36495495631 passed. The **inactive P1 capture-persistence checkpoint**
is verified within the bounded evidence below, documented in ADR054 and F03: migration 0121,
one owned claim/capture/accounting operation, atomic audience/marker and tracked
deadline/disposal admission. No-service database checks passed 124 files / 902
tests; build/typecheck, schema and architecture checks passed. One separately
approved PostgreSQL run passed all 18 capture cases (zero failures/skips/retries;
8.81-second suite). Independent review accepted the result in
`/tmp/pertexo-inbox-capture-pg.PhjxF6`. Its owned database
`pertexo_test_inbox_capture_85cb54612211495db66323042171c902` (OID 281930) was
normally removed with zero connections; parent/child exited zero and the child
group was absent. The seven-database baseline remained SHA256
`8dea1fc6b8892e8d35c3ad819bf609bc769ec90956eef9dde6c275522bb6f954`.
Runtime-role/tenant guards, audience/fence contention, uncertainty/rollback,
expiry/statement-timeout and removed/corrupt-evidence cases passed. Corrections now
observe driver end before releasing admission, check fresh expiry after audience
completion, and consume removed source/outbox evidence only as an unavailable
no-op. Retained evidence still validates; deleted bytes cannot be authenticated
by the identifier-only interface. Disposal is not proof of backend rollback.
No services were started/stopped, and no Redis/API/browser/providers were used.
Driver-interposed acknowledgment loss and an arranged shortened lease are not
aggregate-load or cancellation-capability-at-load proof. No producer, worker/
transport integration, activation or first usable inbox is claimed. Full F03,
retention/resume and real runtime/load gates still precede producer activation.

P1 subsequently merged through PR116 at main
`61a1e9135cb14ababbf8cb73f64431525b855b3d`, with natural main CI 36513163444 and
CodeQL 36513163353 passed without reruns. This does not complete F03.

The next **inactive P2 fan-out persistence checkpoint is locally qualified but
uncommitted**. Migration 0122 adds owner-executed claim/page/failure
commands, private delivery validation and exact raw worker write revocations;
historical migrations remain unchanged. `projectNextPage` owns <=100 saved IDs,
ordered shared user/member locks before source locking, one fixed-set
revalidation, current eligibility and atomic entry/revision/decision/cursor.
Fresh post-page time rejects expiry without partial progress. Shared
feature-local capture/projection admission retains unsettled raw operations and
driver disposal; uncertain commits never initiate failure accounting or replay.
Capture behavior/budgets remain intact; the existing numerical budgets are still
unmeasured defaults, not capacity claims.

Executed no-service evidence: seven focused files / 88 unit/static tests, database
source/test typecheck, isolated-output build and scoped lint passed. Initial lint
failed with 11 test-only errors; reviewed typing/callback/tuple corrections
preserved assertions, then the lint recheck, focused tests and typecheck passed.
Manager review then corrected two raw-grant-test placeholder/value bindings,
preserving every expected `42501`; direct formatting/lint/typecheck passed.
Independent standards/spec reviews returned zero findings. **19/19 real PostgreSQL
regressions passed** in one authorized run (4,332 ms suite, zero failures/skips/
retries). Manager inspection accepted `/tmp/pertexo-inbox-projection-pg.PpEFGy`:
fresh database `pertexo_test_inbox_projection_ad30f47fbbc14a159d91adde452d70cd`
(OID 285525) normally removed, zero connections, parent/child exit zero, monitor
closed and child group absent; the protected seven-database inventory retained
SHA256 `8dea1fc6b8892e8d35c3ad819bf609bc769ec90956eef9dde6c275522bb6f954`.
No service actions, everyday-store/Redis access or further PostgreSQL run occurred.
Concurrent shared-recipient promises are not deterministic contention or load
proof; arranged user-status and driver-ack cases are not OS-process-crash or
cancellation-at-load qualification. No runtime/worker/producer, browser/provider,
load qualification is claimed. The existing
[ADR054 evidence](adr/054-durable-workspace-inbox.md#inactive-p2-fan-out-persistence--locally-qualified-uncommitted-2026-09-29)
records scope, commands/results and tooling limitations. No producer, queue
registration, worker composition, operator recovery, retention execution,
HTTP/frontend, read-all/SSE or deployment-global activation is introduced.

Final affected no-service gates passed: schema (five tests, unchanged 93 tables),
architecture (19 tests plus graph/import), database ESLint, Knip, complexity
(three tests plus ratchet), docs (21 tests, 348 links), formatting and diff checks.
Full database tests first passed 126 files / 928 tests. The unchanged duplication
gate then failed on two shared capture/projection lifetime blocks; reviewed
private extraction in the existing `write-activity.ts` preserved command logic,
deadlines, admission/quarantine and uncertain-COMMIT semantics. Eight public-store
regressions bring focused checks to **96 passed**; isolated typecheck/build and
independent standards/spec follow-up reviews passed after two test-only
deferred-void lint corrections. Duplication recheck passed the unchanged baseline
(source 21 clones / 352 lines; tests 10 / 294), with both reports retained.
Post-extraction full database tests passed **126 files / 936 tests**, then
database lint, Knip, graph/import, complexity, formatting and diff checks passed.
The **19-case PostgreSQL evidence is pre-extraction**, not a fresh run of the
final lifetime code; SQL/transactions remain unchanged and public-store tests
qualify the reviewed lifecycle extraction. No root prepush/coverage or complete
runtime/load/activation gate is claimed; P2 remains inactive and uncommitted.

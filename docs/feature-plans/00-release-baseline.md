# F00 — Release baseline and existing-capability qualification

Status: PR verified/merged — bounded local connected qualification and release
checks passed through PR113/114. External qualification remains separate and open.
User authorized sequential roadmap work on 2026-09-28; this plan
does not authorize external provisioning or production rollout.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Existing implementation / evidence gate. Relative size: **M**, not a calendar estimate.

## Outcome

A recorded, bounded starting snapshot for feature work, without restarting a whole-repository cleanup or repeated blind CI runs.

## Current implementation and evidence

Core workflow execution, versions, triggers, run inspection, cancellation/replay and role-scoped storage exist. Phase 7 still distinguishes local qualification from configured external production evidence; this roadmap does not close it. The intermittent account-link issue remains unresolved separately.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/implementation-progress.md](../../docs/implementation-progress.md)
- [docs/backend-structure-audit.md](../../docs/backend-structure-audit.md)
- [apps/web/ARCHITECTURE.md](../../apps/web/ARCHITECTURE.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

Current backend structural cleanup and its reviewed merge.

Which deployment/provider access is configured and explicitly authorized remains an external release gate. Do not request secrets in chat.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Existing feature owners and test harnesses; no new runtime module.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Verify the three existing journeys using actual local stack: webhook→validate/map→branch→controlled action; schedule→bounded loop→transform; manual run→failure inspection→safe replay/cancel. Include desktop/mobile, keyboard and reload.

## Backend work

Record exact merged source and fixtures, expected run/node counts and recovery evidence. Keep account-link qualification, production mail/OIDC, object storage and deployment obligations explicit, not hidden behind green mocked tests.

## Delivery slices

1. Record merged source, clean owned test setup, existing supported feature matrix and unresolved limitations.
2. Run bounded risk-based smoke checks only for missing or changed evidence; retain exact run IDs and outcomes.
3. Triage actual regressions separately; permit unrelated feature planning without calling unverified behavior production-ready.

### Starting snapshot and bounded qualification ledger (2026-09-28)

Fetched `origin/main` and verified
`fcb0c44ca5d9f1a921165207fb33f2802d1688f7`. PR
[99](https://github.com/vigani1/pertexo/pull/99) merged the reviewed backend
structure delivery; PR [100](https://github.com/vigani1/pertexo/pull/100) merged
account-link interleaving regression tests. Natural main CI
[36367848286](https://github.com/vigani1/pertexo/actions/runs/36367848286) passed
on that exact source. This is reused baseline evidence, not a rerun or a claim
that the following connected journeys passed.

The earlier **zero-success account-link observation remains unresolved**. PR100
covers a different one-accepted/one-losing callback interleaving, including
deterministic ordering and cleanup; it does not close the older observation.
External Phase 7 production/provider/deployment obligations remain separate.

| Connected acceptance | Existing evidence inspected | Missing evidence / bounded next check |
| --- | --- | --- |
| Webhook → Validate/map → branch → controlled action | Backend trigger/engine tests; existing settings and mocked editor/browser controls; prior controlled API/worker verification recorded in backend structure audit | Browser-authored graph saved/reloaded/published through real API; actual webhook delivery; expected branch/action output; exact retry causes no second external effect. Local controlled provider only |
| Schedule → bounded loop → transform | Schedule builder/server preview and worker loop integration fixture exist | Authored and reloaded bounds, actual scheduled occurrence materialization, **nested 2×2 = four leaf completions** with scoped item/ordinal outputs and restart. Existing `nested_complete` fixture is 3×1, not a substitute |
| Manual → failure inspection → safe replay/cancel | Existing run detail/replay/cancel contracts and API/worker cases; mocked publish-to-run browser journey | Real authorized run, readable failed node/input/output, bounded explicit replay/cancel result; terminal cancellation and no duplicate accepted command/effect |
| Mapping completeness | F01 catalog/control source matrix; component/model and mocked browser tests | Real saved/reloaded graph exercises all five mapping kinds; missing path omission, exact expression context, nested scope isolation and correct error target |
| Editor resilience | Existing mocked two-tab ETag conflict, scratch/navigation/identity pause, undo and responsive browser cases | Connected real API two-tab conflict preserves both versions; reload and immutable accepted version remains correct after later draft edits |
| Accessible useful layout | Existing mocked keyboard and 390/1024/1280/1440 editable/read-only journeys | Fresh rendered inspection of changed controls, keyboard/focus/errors, no accidental scratch loss at those widths; distinguish mock-only UI verification from real stack |
| Identity/tenant boundaries | Prior real PostgreSQL/RLS and real API session tests in backend audit | Real browser session + API with denied/other-workspace attempts; no hidden protected data or cross-identity retry; no client-only atomic-identity claims |

Canonical test owners: `apps/web/e2e/workflow-editor*.spec.ts`, their existing
support fixture, `apps/api/test/support/better-auth-real-api.integration.support.ts`,
`apps/worker/test/coordinator-consumer-foreach-cancellation.integration.test.ts`,
and existing trigger/authoring/run API integration tests. Extend established
public seams, not a second evaluation/authorization framework. The API helper
originally used Fastify injection; the approved test-only loopback composition
now has initial smoke evidence below. Use current Better Auth contracts (ADRs 039/043), and do not
mistake older OIDC documentation for the current local auth runtime.

Fixture safety: the current task's approved invocation uses the established owned
project `pertexo-structure-verify-20260928` (PostgreSQL 55436, Redis 56380), after
an immediate container ID/project/port preflight. Reusable code accepts an
explicit manifest rather than hardcoding dated service IDs, but an operator
must independently verify and obtain approval for the manifest's task ownership
before execution. Docker matching plus an attestation is not proof that an
arbitrary supplied project belongs to this task; never infer approval from
detected containers or defaults. New service manifests require ownership
preflight approval. The default `pertexo` project and known older 55435/56379
fixture are denied. Test harnesses create
unique disposable databases and own queue/Redis prefixes; retain exact fixture,
source and run identifiers in evidence. Do not reset the older 55435/56379
stack, Redis DB12 lease, unidentified databases or shared service state. A
planned invocation is not executed evidence; do not publish credentials.

Next: review F01 bounded gap plan, execute only the narrow changed/missing
checks, then compose the real journeys above. No broad cleanup or repetitive
CI reruns. Missing external provider/deployment access remains a qualification
limit, not permission to provision services or to label the slice production-ready.

### Approved initial test-only live composition

- Owner: API integration test/support, not application runtime or web feature
  code. Reuse `createApiApplication`/Better Auth and migrated disposable-database
  setup, expose a loopback listener with Nest/Fastify's existing `listen(0,
  '127.0.0.1')` seam. No fake session guard, new public endpoint or production
  registration. Use current API/session/CSRF request builders in the browser.
- Browser host: existing built Vite application on preflight-free fixed port
  4174 with strict port ownership; set the existing `PERTEXO_API_PROXY_TARGET`
  to the owned API listener origin. The `/v1` same-origin proxy carries auth
  cookies and SSE without substituting responses. Configure the fixture's
  public web origin to that actual host, local mail sink, insecure-cookie test
  mode and no social provider. Browser performs ordinary signup, mail-sink
  verification and sign-in. Local email/password proof is not provider/OIDC proof.
- Isolation: immediate exact project/container/port checks for the owned 55436
  PostgreSQL and 56380 Redis; create one UUID-named database with normal runtime
  roles and current migrations. Use an exclusively owned Redis database/queue
  namespace and assert no unrelated keys before acquiring it; never select or
  clear DB12. Record the lease and exact IDs before mutation. If an exclusive
  queue namespace cannot be established through existing configuration, hold
  worker dispatch instead of clearing a shared queue.
- Worker: reuse current coordinator/node-attempt runtime constructors and the
  owned child-process lifecycle from the For Each integration fixture. Activate
  one consistent catalog cohort and record its fingerprint. For the initial
  all-five-mappings/2×2 proof, use only pure core nodes; no outbound action is
  required. Worker restart uses only its recorded PID/handles, ready handshake,
  bounded SIGTERM and cleanup error reporting. Schedule scanner/dispatch must
  use existing runtime constructors, not direct SQL masquerading as a trigger.
- Controlled-action gate: a later webhook/action leg must use a test-owned local
  endpoint and the existing integration transport-injection seam only after its
  egress setup is reviewed. Never enable private-address egress globally or
  substitute invented action results. Until that concrete setup is approved and
  exercised, do not call the webhook-to-external-action journey qualified.
- Scenarios: browser authors all five mappings and loop bounds, saves/reloads,
  publishes and starts; assert accepted immutable version, actual node outputs,
  missing-path omission and four nested leaf completions. Two contexts exercise
  a real ETag conflict, retained comparison and explicit reapply. Add invalid
  expression issue focus and authorized failure inspection/replay/cancel through
  actual endpoints. Desktop/mobile/keyboard, read-only and other-workspace
  attempts use real authorization. Deliberate lost acknowledgements may abort
  the browser response **after** the real server commits; count durable receipts
  and effects, rather than mock successful JSON.
- Cleanup: close browser, proxy/API listeners, worker consumers/owned children
  and pools; remove only the proven fixture queue keys and disposable database.
  Recheck IDs/lease before destructive cleanup, preserve diagnostic run facts
  without raw credentials and fail on incomplete disposal. Never stop the shared
  services or delete another run's database/namespace. No environment access or
  external-provider completion is inferred from this proposal.

Manager approved the initial pure-node composition on 2026-09-28. The test-only
owner is `apps/api/test/editor-browser.integration.test.ts`, using the existing
Better Auth fixture, a dedicated worker process fixture and
`apps/web/e2e-live/editor-execution.spec.ts`. It requires explicit
`EDITOR_BROWSER_OWNED_FIXTURE=true` and an ownership manifest containing the
approved Compose project, exact PostgreSQL/Redis container IDs and host ports;
Docker inspection and all configured URLs must match before resource acquisition.
No service IDs/project/ports default to a shared environment. The local invocation
used the established fixture above. Each Node child has an owned process group;
Vite build/preview and Playwright are direct children, not nested pnpm shells.
Teardown confirms descendant exit before releasing the worker/Redis lease. If
external disposal cannot be confirmed, the API fixture preserves its UUID
database instead of deleting it under those clients.

Initial real smoke passed: API integration **1/1**, live Chromium **1/1** (16.45s
total; browser 6.8s). Ordinary signup, local verification email, sign-in, first
workspace, browser-created workflow, literal mapping, autosave/reload, publication
and actual accepted worker execution passed. Durable inspection asserted a
`succeeded` run belonging to the expected workflow/workspace. Before launching
Chromium, authenticated real HTTP guard/store probes check required catalog,
discovery, connection/failure-alert, workflow/draft and run/statistics endpoints.
The fixture activates the selected compatibility cohort using existing release
procedures before booting the matching API/worker. Connection discovery uses
actual persistence/authorization; credential operations and external calls remain
fail-closed. Earlier red runs exposed missing fixture modules/cohort configuration,
not a confirmed production routing defect; no production route workaround was made.

Final focused rerun, after removing diagnosis-only probes, passed **1/1 API** and
**1/1 Chromium** in 16.09s (browser 6.6s). It also reads the actual node output and
asserts inline `{literalProof: "from-real-browser"}`, with one succeeded node.
Durable result identifiers: run `01a0e612-f11f-73aa-bd20-bea195931914`, workflow
`01a0e612-df15-708a-9702-7fe0f1072af5`, workspace
`01a0e612-ddaa-752a-8928-9fc895b03446`. These are test-result IDs, not retained
production objects; normal fixture teardown removed their owned database/queue.
The invocation is the explicit approved ownership/environment configuration plus
`EDITOR_BROWSER_INTEGRATION=true pnpm --filter @pertexo/api exec vitest run
--config vitest.integration.config.ts test/editor-browser.integration.test.ts`.
Existing real API fixture consumers passed **3 files / 5 tests** (4.59s); fixture
resource/disconnected-database/API-bootstrap unit tests passed **3 files / 81
tests** (2.95s). This smoke predates the subsequent review corrections below;
it does not qualify their real Redis/application lifecycle until a reviewed
rerun. No additional real-stack runs were made during the safety-review hold.

Safety-review corrections (independently reviewed; latest live teardown remains
failed as recorded below):

- Canonical worker test namespace cleanup now checks the exact token, selects
  only its validated target database, flushes and releases that exact lease in
  one Redis script. A mismatch or failed script disconnects without another
  destructive attempt or lease release. Unit regression reproduced the previous
  flush-before-token-check; the seven canonical namespace tests pass. The new Lua
  path has now passed the narrow approved real Redis probe recorded below.
- Pure-node fixture shutdown drains all acquired runtimes, but retains its
  Redis namespace/lease if any runtime shutdown fails. It reports bounded phase
  identifiers through IPC, not raw errors/secrets. Three dispatcher/attempt/
  coordinator failure probes reproduced premature namespace release before the
  correction; four focused shutdown tests pass.
- Parent disposal requires successful worker acknowledgment and exit zero;
  worker exit failure or unconfirmed disposal preserves the UUID database.
  Vite's intentional SIGTERM remains separate. Process polling was rejected as
  proof: a short-lived intermediary may leave an unseen detached child. The
  retained mechanism uses private owned groups for direct processes plus an
  explicit browser fixture lifetime receipt. Each worker registers its unique
  instance before use; it acknowledges disposal only after awaiting actual
  `browser.close()`. The parent requires at least one registration and no open
  instances; missing/failed acknowledgment preserves the fixture even after the
  CLI exits. No generic process supervisor or host-wide PID inference remains.
  Eight spawned-process probes include a short-lived intermediary leaving a
  detached child, refusal of destructive follow-up without a receipt, worker
  failures, explicit browser proof and forced private-group reaping. The fault
  test removes only its explicitly issued child PID; it does not claim the parent
  discovered or reaped that unknown descendant. No shared-service outage was
  induced.
- Exact approved container/project/port ownership is rechecked immediately before
  Redis cleanup through bounded parent/worker IPC and before the actual UUID
  `DROP` after observing disconnected clients. A failed recheck closes handles
  without deleting data/lease/database. Focused tests cover ordering and mismatch
  refusal. Neither initial preflight nor a prior green smoke substitutes for
  this deletion-boundary check.
- Verification-link navigation catches failures at the secret-bearing boundary
  and emits a fixed error with no original cause/URL. An isolated intentionally
  failing Chromium reporter probe checks that the actual reporter output contains
  neither its dummy verification token nor URL. It is a negative redaction test,
  not a successful application/provider journey. Explicit fault-mode discovery
  keeps it out of ordinary live acceptance.
- Ownership preflight tests reject missing attestation/manifest, default project,
  old fixture, configured URL mismatch and exact Docker ID/project/state/port/
  binding mismatch before acquisition. Supplied test doubles prove refusal
  logic, not real environment ownership.

Latest local safety delta: API **4 files / 28 tests** pass (1.92s), including
the actual isolated negative Chromium reporter, real spawned-process fault
probes, mocked ownership refusal and database-disposal ordering. Worker **2
files / 11 tests** pass (119ms), including failed recheck/disconnect without
lease deletion. These are not a real application-stack rerun or actual Redis
script evidence. The deletion-boundary ownership check and browser-lifetime
receipt passed independent review. The approved narrow rerun did not pass teardown.

Post-review real verification: exact approved Docker IDs/project/ports and health
were checked before execution. The Redis DB11 probe executed the canonical atomic
Lua cleanup successfully, then deliberately supplied a wrong token only for its
own cleanup call. Actual Redis preserved the owned marker and original lease.
After another ownership check, exact-owned-token cleanup left DB11 empty and its
lease absent. No other namespace or competing owner's lease was changed.

The subsequent literal browser scenario passed **1/1 Chromium** (6.9s; browser
suite 7.5s), including actual succeeded execution and inline node output. However,
the API integration **suite failed in teardown** (16.64s): the parent did not
confirm successful pure-node worker acknowledgment/exit. Read-only inspection
found DB11 empty and its lease absent, but the fail-closed path retained
`pertexo_test_ba_editor_browser_157fe6839633449e834653698053d7a6` rather than deleting
the database. Durable run `01a0e632-7593-71c4-bff1-1e592c3816ea`, workflow
`01a0e632-6356-76df-aeac-3f002902df13`, workspace
`01a0e632-618a-719d-a95f-5437f80b01ec` belong to that retained disposable fixture.
This is not a green live gate. No cleanup fallback, further live run, commit or
push followed the failure. A bounded shutdown diagnostic now reports only
acknowledgment/exit/signal and whitelisted phase names; its spawned-process
regression passes (**9/9** process tests, 768ms), without exposing raw errors.

One explicitly approved diagnostic rerun also passed its **1/1 Chromium**
scenario (6.8s), but failed the same integration teardown (16.36s); its gated
diagnostic did not reveal the inner cause. This does not supersede the failed
gate. A subsequent isolated actual tsx fork under the API integration Vitest
configuration passed **1/1** (213ms), exercising SIGTERM, memoized disposal,
IPC acknowledgment and the process's own disconnect callback without any
database/queue/browser. That rules out the isolated callback sequence as a
sufficient reproduction, not an actual worker cause. Protected disposable
databases have not been manually removed.

After adding fixed diagnostic teardown-stage labels (without changing disposal
rules), one final explicitly approved rerun passed **1/1 API integration** and
**1/1 Chromium** (17.44s total; browser 7.5s). Run
`01a0e638-bbb3-70d0-a6f4-d8224b4fd839`, workflow
`01a0e638-a94b-77d3-af4e-927421af5921`, workspace
`01a0e638-a78f-73ec-8a03-18a1c6fe0e0f` passed the actual output assertions.
Successful suite teardown requires browser disposal receipts, successful worker
acknowledgment plus exit zero, and immediate ownership rechecks before deletion.
Post-run read-only inspection confirmed DB11 empty/lease absent and only the two
previously retained databases present (`157fe6839633449e834653698053d7a6` and
`faebe682cbfc4c7f9b58e00d8f62f666` suffixes); the successful run's database was
removed. This isolated green rerun **does not establish the cause or resolution
of the prior intermittent teardown failures**. No additional literal rerun,
manual cleanup, commit or push followed it. Fixed diagnostic stages have focused
missing-worker-proof/forced-exit coverage: process **9/9** (765ms), isolated tsx
integration-pool probe **1/1** (163ms); lint and API typecheck pass. The next
all-five/nested test-only scenario is approved for implementation; independent
diff review remains required before its live execution.

The independently approved all-five/nested 2×2 continuation passed its actual
browser and durable assertions (**1/1 Chromium**, 21.0s), but the API suite failed
teardown (30.90s). Fixed diagnostics finally identified this run's failure:
`stage=wait-group`, successful worker acknowledgment, no failure phases, exit not
yet observed, native polling `EPERM`. This is not evidence that worker shutdown
failed, nor proof that the two older failures had the same cause. The fail-closed
path retained `pertexo_test_ba_editor_browser_39f0b0b164e6498ba24476e69e392ff0`.
Exact-owned read-only inspection found DB11 empty/lease absent and all three
retained databases unchanged. Sanitized logs are
`/tmp/pertexo-f01-nested.KW84Ea/nested-authoring.log` (first canonical-shape
expectation failure) and `nested-authoring-corrected-contract.log` (successful
execution, failed teardown). No manual cleanup occurred.

The narrow correction treats **only signal-zero `EPERM` as unconfirmed group
presence within the existing bounded wait**, never as disappearance. `SIGTERM`
and `SIGKILL` failures still reject; persistent inability to confirm group exit
retains the fixture. Successful acknowledgment, exit zero and eventual absent
group are still required. A spawned-process regression was red on the prior
guard, then green: **13/13** process tests (1.32s), including transient/persistent
poll denial and both mutation-signal denials; the actual tsx integration-pool
probe passed **1/1** (165ms). Lint, API typecheck and diff checks pass. This
correction passed independent review; local tests alone do not close the full gate.

One approved corrected connected rerun then passed **1/1 API integration and
1/1 Chromium**, 30.82s (browser 21.1s), with complete teardown. Sanitized log:
`/tmp/pertexo-f01-nested.KW84Ea/nested-authoring-bounded-poll.log`. Durable result
IDs: run `01a0e646-734c-720b-bec5-c7978bf4f2f1`, workspace
`01a0e646-2ddc-75fe-bdbc-6337789d8cf6`, workflow
`01a0e646-2fb9-7502-86a4-8101887e7b79`, immutable version
`01a0e646-6b82-746c-94f2-08ee5336f24d`. Root step
`6b618856-43b1-41a4-bfb7-59d1aeeaac52`, outer loop
`75d51c9f-af3c-49a1-a62c-bf60e5c277ae`, inner loop
`3e22b502-29d8-45ed-9d6b-2cb83fa2dd37`, leaf
`fbcfbcc3-b775-46e7-9c81-ce051560f052` were browser-authored. Exact all-five saved
mapping shapes, full graph after reload/publication, root omission/expression
semantics, eight successful invocations, four distinct leaf values/inputs and
four exact two-level durable iteration paths passed. Post-run exact-owned
read-only checks confirmed DB11 empty/lease absent, only the three older preserved
databases present, and normal deletion of this run's UUID database. No manual
cleanup was used. This qualifies the bounded connected scenario and corrected
polling path; it does not retrospectively explain the two older failures.

Subsequent independently reviewed connected extension passed **1/1 API integration
and 1/1 Chromium**, 42.37s (browser 32.3s), with successful teardown. It retained
all-five/nested assertions and added two ordinary same-owner sessions: actual
stale-ETag 412, both graph copies retained, explicit remote-baseline acceptance
without a force write, and explicit local reapplication against the new ETag.
Later draft edits preserved the published graph/version and accepted run output.
A separately registered/verified identity discovered only its own workspace and
received actual nondisclosing 404 responses for the other workspace's draft,
versions and runs; the editor UI remained unavailable. Durable state contained
one published version, one run and final draft revision 10 (conflict revision 8).
Run `01a0e654-45aa-71ba-bb91-8434c2e93732`, workspace
`01a0e654-0045-7561-922f-3349676bd999`, workflow
`01a0e654-0201-755f-a555-0c6b534d9825`, version
`01a0e654-3dd1-742e-95c0-4db888c7d268`; outsider workspace
`01a0e654-78fb-7173-936a-c3447bce8bbc`. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-conflict-version-isolation-corrected-landing.log`.
An initial attempt failed only the existing owner's exact sign-in landing test
expectation; the corrected test follows the inspected single-workspace landing
contract. Its cleanup succeeded. Latest post-run exact-owned checks confirmed
UUID database deletion, DB11 empty/lease absent and the three older preserved
databases unchanged. API/web typecheck/lint pass; cached React Doctor 0.9.14
reports no diagnostics across 19 changed/untracked files, uploads disabled.

These results close real two-tab conflict, later-edit/immutable-version follow-up
and workspace-read isolation for this bounded scenario. Failure/replay/cancel,
invalid-expression focus, real read-only authorization, controlled-action,
schedule, provider/OIDC and cross-browser gates are not closed. F00/F01 remain
in progress; additional live cases require the bounded proposal/review sequence.

Before adding independent live cases, an isolated no-stack regression reproduced
a browser-lifetime accounting gap: failed initial launch registered no pending
receipt, and failed restarted-worker launch could be masked by an earlier browser's
close receipt. The focused correction registers a unique pending lifetime before
resolving Playwright's inherited browser fixture; only explicit successful close
can remove it. Standard launch/options/connect/context behavior is retained.
The three actual Playwright process probes (initial launch failure, restarted
launch failure after an earlier receipt, ordinary context/close) and the existing
reporter-redaction probe pass **4/4**, 2.49s. The two failure regressions failed
before the correction. Pending UUIDs and the owner's refusal to release resources
are asserted, not merely process exit. No application, database or Redis was
started by these probes. Web/API typecheck, web lint and focused root lint pass;
normal live discovery remains one unchanged connected case. Independent review
approved the safeguard and separately reran all four isolated checks (1.86s).
Subsequent expanded evidence is recorded below; these isolated safeguards alone
do not qualify the application journeys.

The independently reviewed receipt-recovery journey subsequently passed **1/1
real API integration / 1/1 Chromium**, 21.70s total (browser 11.6s), including
normal teardown. Actual committed publish and run responses were lost before
browser observation; explicit retries retained the original body, publish ETag,
idempotency keys and deadline despite later draft/form edits. Durable assertions
checked one immutable version, one succeeded run, one node attempt, two completed
receipts and exactly one publication/start audit. Run
`01a0e67f-d19e-7278-bf78-bcb4222cd226`, version
`01a0e67f-bfb8-75d5-adff-6b3e0a398383`; log
`/tmp/pertexo-f01-nested.KW84Ea/editor-receipts.log`.

The separate failure/replay/cancel journey is **not green**. Its first attempt
failed at mobile focus (69.87s): the test used the desktop comma/duration label
instead of the actual exact mobile `Replay gate: Failed` label. The approved
test-only correction preserved keyboard, sheet, Escape/focus and timeout checks.
One corrected run failed (69.80s) at the separate Wait control: exact `Wait for`
did not match the rendered `Wait for (in seconds)`. Actual failed-step input/error,
mobile sheet/focus and corrected replay had passed before this second failure;
cancellation and final durable assertions have not yet run. Logs:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery.log` and
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-exact-mobile-label.log`.
Both failed attempts completed normal teardown. Immediate owned checks after all
three new runs confirmed normal UUID database removal, empty DB11/no lease and
the three older diagnostic databases untouched. New live attempts stop on failure
and require bounded diagnosis/review; already-covered journeys are not repeated.
No product behavior or timeout was changed for these selector mismatches. Local
email/password, PostgreSQL, Redis and worker evidence is not external provider,
production, schedule/controlled-action or cross-browser qualification.

One reviewed exact-field-label recovery run then failed **1/1 API / 1/1
Chromium**, 26.80s total (browser 16.7s), after real Wait duration 600/waiting and
“Keep running” preserving `cancelRequestedAt: null`. The test reopened through a
global `Cancel run` locator while the closing dialog still exposed its submit
button, causing a truthful strict two-match error. The source and artifact show
a mobile `Run actions` group for a scoped opener; explicit dialog-close waiting
is needed before reopening. Final confirmed cancellation/durable assertions are
still unverified. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-exact-field-labels.log`.
Normal teardown and immediate approved-resource checks passed; no automatic
retry, product change, sleep or timeout increase followed. Default frontend
tests passed **98 files / 688 tests**, 28.81s; this is not the missing live gate.

The reviewed scoped-dialog recovery run passed **1/1 Chromium**, 17.7s (suite
18.3s), including actual failed-node inspection, corrected replay, Wait and
terminal cancellation. Its **API integration failed**, 27.67s total: exact event
array expectations reversed the query's `ORDER BY type` result. Both required
event types were present once; earlier durable run/version/node assertions
passed, but the later cancellation audit count has not run. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-scoped-dialog-lifecycle.log`.
Normal teardown and exact-owned checks passed. Final combined qualification
remains incomplete until the reviewed expected-order correction and durable
audit assertion pass; no automatic rerun was started.

The next explicit-C-order run passed **1/1 Chromium**, 16.3s (suite 16.8s), but
API integration failed (26.51s) on an incorrectly swapped expected event array.
Both event counts remained one; normal teardown/owned checks passed. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-deterministic-events.log`.
A no-stack byte-order assertion then proved `run.cancel_requested` sorts before
`run.canceled` under C collation (underscore byte 95, `e` byte 101). The exact
expected array is corrected to that proven order without weakening counts or
audit checks. The final connected durable/audit gate is still pending; these
verifier mistakes do not establish a product defect.

Final reviewed recovery gate **passed 1/1 real API integration / 1/1 Chromium**,
27.39s total (browser 17.7s; suite 18.2s), including final SQL/audit assertions
and normal teardown. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-proven-c-order.log`.
The connected failure → phone inspection/focus → same-version corrected replay
and actual Wait → dismissal → terminal cancellation journey passed. Durable
state contains exactly three runs/node attempts, two versions, the correct
replay source, both cancellation events once and one cancellation audit.
Failed run `01a0e68e-2e16-742d-ae34-d8a494a715b5` and replay
`01a0e68e-316a-769f-a8b3-c8261e054677` share version
`01a0e68e-25cd-7681-8b8b-2f9238740330`; canceled Wait run
`01a0e68e-4d8e-77d9-bdd0-d45cc255bb1c` uses version
`01a0e68e-45be-75b5-acfd-9a05029d1c4c`. F01 records full workflow/workspace IDs.
Immediate approved-resource checks confirmed normal UUID database deletion,
empty DB11/no lease and three older diagnostic databases preserved. This closes
the local manual recovery and exact-command receipt gates, not all F00 gates.
At that checkpoint, expression admission, scheduled/controlled-action, real
read-only identity, provider/production and cross-browser evidence remained open.

The later reviewed expression-admission gate passed **1/1 real API integration
/ 1/1 Chromium**, 29.46s, after a routed red/green regression confirmed and
corrected Fix changing tabs before scratch approval. The unchanged live spec
checks nested invalid-expression findings, strong checked-snapshot ETags,
blocked publication, guarded keyboard navigation, explicit correction, immutable
publication and exact-version execution. Real PostgreSQL verification found one
version, one succeeded run, two succeeded nodes, exact completed command
receipts, singular publish/start audits and the expected leaf input/output.
[F01](01-editor-capability-completion.md) retains the initial failure, causal
correction, full IDs, sanitized log, independent review and normal cleanup
evidence. This closes only the bounded local expression gate. Scheduled and
controlled-action composition, provider/production and cross-browser
qualification remain open; F00 is not complete. The later bounded real
read-only identity gate passed as recorded below.

### Remaining qualification slices — read-only gate accepted, later slices plan only

Reuse the accepted mapping/loop, conflict, receipt, recovery and expression
evidence; do not repeat those journeys to fill these distinct gaps. The local
implementation checkpoint is `8dbe73a4` (checked authoring expression admission),
after `494fb9cc` and `45644ec9`; these local commits are not push or release
qualification. The reviewed live harness is committed locally as `56537cfc`;
the accepted read-only scenario is the next selective test checkpoint.
No invocation or production change is authorized by the proposals below.

1. **Real read-only editor identity — accepted bounded local gate.** The owned API/browser
   composition and existing isolation helper with a separately registered,
   mail-verified, signed-in account. Give it an active viewer membership only in
   the disposable workspace, using the existing controlled membership setup
   seam from `better-auth-membership-lifecycle.integration.test.ts`; record this
   privileged fixture setup explicitly, not as a public invitation journey.
   Do not fake session/capability guards or inject discovery responses. The owner
   authors the workflow normally. Viewer discovery and draft/version/run reads
   must pass through real HTTP authorization; draft save/publish/run-start must
   return their actual nondisclosing denial contracts with ordinary CSRF, and
   must leave graph, revisions, versions, receipts and runs unchanged. Inspect
   useful canvas bounds, inspector access, keyboard/focus and absent write
   controls at 390/1024/1280/1440. Keep cross-workspace denial distinct from
   same-workspace read-only access. One scenario, one disposable database and
   the existing child/browser/Redis ownership protocol; no provider is needed.

   **Exact read-only test seams (implemented and qualified below):**
   `useBetterAuthRealApi().database()` is the existing superuser pool on the
   disposable database (`better-auth-real-api.integration.support.ts`); the
   lifecycle integration test uses it to insert a membership after obtaining
   both real user IDs from `/v1/users/me`. Reuse precisely this setup statement
   with viewer rather than builder:
   `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')`.
   Parameters must be IDs of the workspace and verified recipient created in
   this invocation. Scope any added fixture-control handler to this selected
   scenario and its owned IDs; do not add an application endpoint or accept
   arbitrary workspace/actor grants. The viewer signs in ordinarily after the
   setup and discovers its capability snapshot through the real API. This is
   explicitly fixture-admin membership, not invitation/role-change evidence.

   | Request with viewer's real cookie | Expected contract/result |
   | --- | --- |
   | `GET /v1/users/me`, `GET /v1/workspaces` | 200 shared identity/discovery schemas; selected membership is active viewer, without update/publish/run-start capabilities |
   | `GET /v1/workspaces/:workspaceId/workflows`, `GET …/workflows/:workflowId`, `GET …/workflows/:workflowId/draft`, `GET …/workflows/:workflowId/versions` | 200 corresponding shared authoring schemas; draft carries its real strong ETag |
   | `GET /v1/workspaces/:workspaceId/runs` | 200 shared run-list schema; an empty list is truthful if this setup has not run |
   | `PUT …/workflows/:workflowId/draft` with original graph and If-Match | 404 `resource.not_found`, not 403: `WorkflowUpdateGuard` uses nondisclosing mode |
   | `POST …/workflows/:workflowId/publish` with original If-Match and a fresh test key | 404 `resource.not_found`: `WorkflowPublishGuard` |
   | `POST …/workflows/:workflowId/runs` with schema-valid `{input:{}}` and a fresh test key | 404 `resource.not_found`: `WorkflowRunStartGuard` |

   Deliberate denied requests use the signed-in viewer's actual CSRF cookie and
   matching header, following the existing real-API command helper; do not seed
   cookies or fake guard results. Record these as test-driven HTTP denial
   probes, separate from UI-generated commands. Browser UI must emit no write
   requests: Add a step/palette, Publish, Run and mutable step-menu controls are
   absent; Label and applicable Setup fields are disabled; Undo/Redo cannot
   mutate history. Select a node through keyboard Enter, inspect Setup/Inputs,
   and exercise fit/zoom plus navigation back to workflows. At 390 use the
   Canvas/Step panel buttons, verify inspector access then return to Canvas;
   at 1024/1280/1440 measure actual canvas and visible covering lenses. Assert
   at least 300px uncovered width and height after closing the inspector (and
   at least 500px uncovered width with the inspector open on desktop), not
   simply the full underlying ReactFlow rectangle. Capture screenshots and
   assert focusable controls remain within the viewport and do not overlap
   essential zoom controls. The actual `data-canvas-cover` geometry and
   `uncoveredArea` semantics are the source for those measurements.

   Capture owner-side HTTP draft body/ETag/version list before and after. Final
   durable inspection is confined to this workspace/workflow: identical
   `app.workflow_drafts` revision/graph, identical `app.workflow_versions`, no
   additional `app.workflow_runs` or joined `app.node_runs`, no new matching
   publication/run idempotency records and no corresponding workflow/run audits.
   Do not compare unrelated global counts. The single viewer insertion must
   remain active viewer with no additional membership change; verify both real
   sessions still work. Existing browser lifetime registration, child ownership,
   disposal receipts and Redis cleanup protocol are unchanged; only the narrow
   scenario-specific setup/evidence branches were independently reviewed. Their
   one accepted invocation is recorded below, not authorization to repeat it.

   **Executed evidence:** 1/1 real API integration and 1/1 Chromium passed in
   22.40s (browser 12.2s), including shared schemas, real cookie/CSRF 404 denials,
   separate UI zero-write observation, four widths, keyboard and hit-tested
   controls, unchanged scoped durable facts and normal cleanup. Manager
   inspected all eight screenshots. [F01's read-only evidence](01-editor-capability-completion.md#real-read-only-editor-qualification-2026-09-28)
   records exact workspace/workflow/viewer IDs and limitations: fixture-admin
   membership (not invitations/provider proof), after-only catalog sampling
   without the ephemeral name/OID, and no logged baseline run/version IDs.
   F00 remains in progress; schedule/controlled-action/provider/cross-browser
   gates are not closed by this result.

2. **Schedule → bounded nested loop → transform.** The current browser worker
   owns coordinator, node attempts and outbox dispatch; it does not yet own a
   trigger runtime. Compose the existing `createTriggerRuntime` and
   `createScheduleTriggerScanner` owners, using
   `schedule-trigger.integration.test.ts` as the lifetime/scan seam reference.
   Reuse its `schedule_activation` cohort consistently in API catalog,
   publication, readiness, worker registry and scanner. Use the reviewed
   authoring validator, not the older fixture's missing admission option.
   Browser builds and reloads the schedule and nested bounds, checks the server
   preview and publishes. A genuine due occurrence must be scanned/materialized
   and dispatched by the runtime, not admitted as a manual run or inserted by
   SQL. Assert occurrence identity/time, trigger type, exact version, four scoped
   leaves for 2×2, item/ordinal outputs and singular receipts/outbox/audits.
   Reuse existing restart lifetime proof; add only the schedule-specific
   continuation assertion and duplicate scan claim check. The public interval
   minimum is one minute: approve a finite scenario timing budget and due-time
   strategy before implementation, rather than increasing the existing cases'
   timeouts after failures or fabricating a scheduled occurrence. No new Redis
   namespace is inferred from the schedule fixture's DB13 default; reuse the
   independently approved exclusive namespace or obtain separate approval.

   **Concrete schedule qualification — test-only implementation approved.**
   Manager approved the 120s new-case budget, runtime-only restart and focused
   no-service implementation checks on 2026-09-28. Live invocation, commit and
   push remain gated on review of the complete actual diff and checks below.

   - Source owners: `apps/worker/src/triggers/trigger-runtime.ts` composes the
     real reconciliation consumer, published reader and scanner;
     `trigger-runtime-lifecycle.ts` owns readiness, abortable scanning and bounded
     drain. `packages/database/src/triggers/workflow-trigger-materialization.ts`
     anchors a new interval to database `clock_timestamp()`;
     `schedule-recurrence.ts` computes first due as anchor + interval minutes ×
     60,000. `schedule-trigger-scanner.ts` admits the actual published executable
     with `triggerType:'schedule'`, receipt scope `schedule:<triggerId>` and key
     hash of `<triggerId>:<scheduledAt>`, then atomically records the occurrence.
     The existing `schedule-trigger.integration.test.ts` backdates
     `next_fire_at` and rewinds occurrences for its separate recovery/contending
     scanner gate. Reuse its runtime composition, **not those SQL mutations**, in
     this natural-due browser qualification.
   - Cohort: propose `schedule_activation` consistently for API discovery,
     publication/readiness, coordinator, node attempts, trigger runtime and
     compatibility activation in the fresh database. Its serving release makes
     `core.schedule@1` active; do not silently choose v2/v3 or downgrade an
     existing database pointer. Retain current checked authoring admission and
     expression validation even though this graph needs no expression. Assert
     one consistent actual release fingerprint before browser authoring.
   - Public UI: ordinary verified owner creates the workspace/workflow, then
     Schedule → outer For each → inner For each → Set fields. Configure the
     schedule through the existing interval builder: one minute,
     `catch_up_once`. Use literal 2×2 items at the outer loop (there is no
     fabricated manual run input); inner items come from its enclosing item and
     the leaf uses scoped item/ordinal mappings. Set bounds 2/1 for each loop,
     save, reload and compare the graph before publication. Capture the real
     CSRF-backed `triggers/schedules/preview` response with
     `scheduleFireTimesResponseSchema`, then publish through checked ETag and
     normal key. After materialization read actual schedule health/next-runs;
     draft preview is not an authoritative persisted anchor.
   - Approved due-time/budget: **120s for the
     new schedule browser scenario only**, zero retries; keep every existing
     browser case at 60s and the parent API test at 180s. Budget approximately
     30s for public authoring, 60–75s from persisted anchor to accepted first
     occurrence (including the restart below), and 15–20s for completion and
     scoped verification. Poll real endpoints/owned facts with an absolute
     finite deadline; no fake clocks, backdated SQL, manual run start or timeout
     escalation after a failure. If the approved total budget expires, report
     the actual stage and stop.
   - Test-only worker composition: add real trigger runtime ownership to the
     existing `editor-browser-worker-process-fixture.ts`, register
     `reconcileWorkflowTriggers` alongside advance-run/execute-attempt in the
     actual dispatcher consumer capability registry, and check all consumers
     plus scanner readiness. Proposed scanner parameters: 250ms polling,
     batch ≤10, 5s claims, 300s on-time window (all existing validated ranges).
     No new API runtime route or production registry behavior. A second real
     trigger runtime/scanner with a distinct lease owner may compete in this
     one fixture; both use the production checkpoint factory and actual claim
     transactions. Capture scan results only as supporting diagnostics; assert
     the singular durable occurrence/run/receipt rather than only settled
     promises or the sum of returned counters.
   - Recommended restart seam: one bounded, scenario-only IPC/control request
     after publication reconciliation is durably complete and before first due.
     Drain/close dispatcher and trigger/coordinator/attempt owners, then recreate
     their real runtime composition on the **same database and retained exclusive
     DB11 lease**. Rebuild the dispatch registry with the new consumers. This
     avoids clearing active API rate-limit keys or releasing/reacquiring the
     namespace while the browser still polls. Extend the focused worker cleanup
     owner with explicit trigger phases and a runtime-only close seam; aggregate
     errors and retain the namespace on failed close. Keep the current final
     shutdown receipt, parent process-group ownership and destructive-cleanup
     checks unchanged. This proves **worker-runtime restart**, not OS-process
     kill/crash recovery. That distinction is approved; a whole-child
     restart would need a separately reviewed retained-namespace handoff rather
     than silently flushing/reacquiring DB11. Require observed readiness and
     enough remaining pre-due time; never alter the persisted anchor to recover.
   - Connected evidence: no run before the actual first due; after restart the
     same trigger/anchor/fingerprint/version remains. First occurrence equals
     captured `nextFireAt`, outcome accepted; its run is `schedule`, never
     `manual`, and uses the published immutable version. Expect eight successful
     node invocations: Schedule 1, outer loop 1, inner loop 2, leaves 4 with four
     unique scoped paths/item/ordinal outputs. Observe in the ordinary run UI and
     shared input/output decoders. Explicitly disable the schedule through the
     existing management UI after completion, before the next natural interval;
     record its actual command/receipt and disabled state. No SQL rescheduling.
     Final scoped inspection: one schedule row/accepted occurrence/run/checkpoint,
     singular reconciliation outbox/inbox receipt, queued/started/succeeded run
     events, publish/scheduled-acceptance/disable receipts, publication and
     disable audits. Scheduled admission does not create the manual API's
     `run.start_accepted` audit. Two ready scanners are observed composition,
     not deterministic contention evidence; singular durable facts are required.
   - Exact proposed resource scope remains the established owned manifest:
     approved PostgreSQL 55436/Redis 56380, one newly named/OID-recorded disposable
     database, ordinary runtime roles and eight explicit URLs; **DB11 only** with
     its actual **DB10 control lease**, port 4174 and recorded API/mail/Vite/worker/
     browser owners. Never select the schedule fixture's default DB13, old DB12
     lease or shared 55435/56379 services. Capture the ephemeral database name/OID
     before proceeding this time, plus actual trigger/occurrence/run/version/
     node IDs. Final disposal closes browser/worker owners before pools/database,
     verifies no pending scanner claims/live consumers, drops only the recorded
     fixture database, releases DB11 after proven runtime closure and preserves
     the old diagnostic databases/OIDs. Failed shutdown retains evidence/lease;
     no automatic retry or orphan cleanup beyond reviewed ownership.
   - Implementation gates: review the test-only files and focused constructor/
     disposal/cohort checks without services. Only afterward authorize one natural-due
     live invocation. Controlled-action transport/provider work stays separate.

   Test-only implementation evidence (2026-09-28; **bounded local schedule
   qualification passed, including the parent durable verifier**):
   `editor-schedule.spec.ts` and its browser-authoring recipe retain the real
   schedule preview, saved/reloaded 2×2 graph, exact immutable version, natural
   occurrence and explicit disable command. The API's private loopback control
   observes database time and completed reconciliation before/after one
   correlated runtime restart; scoped SQL asserts the occurrence, run, eight
   nodes, four item/ordinal outputs, receipts, events and actual audits. Early
   fixture inspection now records this case's disposable database name/OID.
   The worker lifetime owner keeps DB11 leased through restart, replaces its
   drain/runtime owners, fences stop against reconstruction and refuses namespace
   release after failed close or partial construction. Two real trigger runtimes
   use distinct lease owners and readiness; the dispatcher registry registers
   one reconciliation capability (duplicate job capabilities are invalid).

   Focused no-service checks: worker **2 files / 12 tests**, API restart/process/
   ownership/disposable-resource checks **5 files / 71 tests** pass. API, worker
   and web typechecks, scoped typed lint, three-workspace Knip, architecture
   checks (**19 tests**), documentation checks (**21 tests / 324 links**) and
   `git diff --check` pass. Playwright listing finds exactly the new schedule
   case; listing is not browser execution. Scope restart tests cover correlated
   replies, failed delivery/channel, disposal/exit and timeout without retry;
   lifecycle tests cover setup/restart/stop races, partial acquisition, retained
   namespace on uncertain close, fresh drain and once-owned final cleanup.
   These no-service tests alone do not establish real schedule firing, SQL
   outcomes or rendered controls. The separately reviewed owned invocation's
   evidence is recorded below.

   The first authorized invocation failed: API **1 failed**, Chromium **1
   failed**, 128.71s total / 120s browser timeout. The schedule controls saved
   the one-minute rule, but the draft preview visibly failed; its observer
   filtered out non-200 responses and waited for the case deadline. No nested
   loop, publication, runtime restart or scheduled occurrence was qualified.
   Log: `/tmp/pertexo-schedule-live.2ccRcM/schedule-live.log`. Captured early
   disposable database: `pertexo_test_ba_editor_browser_2cbde6a0da6f4904871b350d653cc95b`,
   OID **250087**. Normal teardown removed it; post-run inspection confirmed
   DB11 empty, its DB10 lease absent, port 4174 free, no fixture child, and all
   three older diagnostic database names/OIDs unchanged. No manual cleanup,
   automatic rerun or timeout increase was performed.

   Diagnosis/correction: the real Better Auth fixture supplied a custom workspace
   database, disabling automatic schedule-runtime creation, without supplying
   that runtime explicitly. A no-service regression at the **same fixture API
   composition** returned **404 instead of 200** with valid proof; the actual
   failed live HTTP status was not captured and is not claimed. Explicitly
   requesting the existing real schedule runtime now acquires it under fixture
   ownership, checks readiness and transfers ownership to the application only
   after successful construction. Existing fixture consumers remain default-off.
   The same ordinary browser owner/workflow checks schedule discovery before
   authoring; its actual CSRF-backed preview is observed regardless of response
   status, with a 10s bound and safe problem-code assertion. The overall 120s/180s
   limits are unchanged. Red→green regression plus bootstrap/runtime checks:
   **2 files / 53 tests passed**, including 401/session, 403/CSRF, 400/schema,
   404/tenant denial, 500/service failure, readiness-failure cleanup and once-owned
   runtime close. This is stubbed persistence with real controllers/guards, not
   real database execution. At that checkpoint the corrected live invocation
   remained gated on review.

   The separately reviewed composition-verification invocation then passed
   schedule discovery/preview, nested browser authoring/reload/publication and
   before-due runtime restart, and observed a naturally accepted first occurrence.
   It **failed** on the assertion comparing history's six-digit UTC text
   (`.148000Z`) directly with health's three-digit text (`.148Z`): API **1
   failed**, Chromium **1 failed**, 84.89s total / 78.698s browser. Log:
   `/tmp/pertexo-schedule-corrected.J1vu41/schedule-live.log`. Early database
   `pertexo_test_ba_editor_browser_92dc7000550743079072b1c9f1926dfb`, OID **253596**,
   was removed by normal teardown; independent post-run observations again
   confirmed DB11/lease/4174/children clear and the three older databases/OIDs
   unchanged. Final node/output/disable/receipt assertions had not run and are
   not qualified by this partial result.

   The bounded test correction preserves both representations: raw six-digit
   occurrence history and original three-digit `firstDueAt`. Only exact zero
   extension is accepted; no `Date`/`Date.parse` equality or fractional truncation.
   SQL occurrence observation uses the existing UTC `to_char(...US...)` text
   pattern and checks exact occurrence ID/scope/run/time. Receipt hashing uses
   the verified **original** scanner-format instant, while the parent separately
   requires `firstDueAt` to equal the restart's captured due text exactly.
   Precision regressions first failed the old raw equality (**2 failed / 10
   passed**), then passed **12/12**, covering zero extension, one-microsecond and
   second differences, malformed precision and original receipt bytes.
   API/web typechecks, scoped lint, Knip, architecture and diff checks pass.
   At that checkpoint the corrected natural-due journey still required a reviewed
   invocation; neither failed attempt was a complete schedule qualification.

   The third separately reviewed invocation passed Chromium **1/1** (80.608s
   browser) through real preview, saved/reloaded nested authoring, publication,
   before-due runtime restart, natural occurrence, eight nodes/four leaf outputs,
   version display and explicit disable. The parent API test **failed** (85.158s
   test / 87.10s total) before its final SQL assertions: it incorrectly compared
   the discovery catalog fingerprint with the composed executable fingerprint.
   Log: `/tmp/pertexo-schedule-precision.oOTJgX/schedule-live.log`. Early database
   `pertexo_test_ba_editor_browser_68f7e6fd48974462806acbee1d7a4885`, OID **257106**,
   was removed normally. Post-run checks confirmed unchanged older database
   names/OIDs, empty DB11, absent DB10 lease, free 4174, no fixture children and
   unchanged healthy owned services. Run/version/occurrence IDs were not retained
   because the identity log followed the failed verifier; do not infer them.

   No-service actual-export reproduction confirmed both epoch-24 fingerprints:
   catalog `node-compat:v1:sha256:d2284b9f98407b692dc751559f78fe4b15f886c181bd6acc34646e739638afce`
   versus executable `node-compat:v1:sha256:4264d2a6af6bb269c3fbceeb0dfb314b41f7e3dd74daacb9ca64b8dfc1f831d4`.
   Discovery uses the registry's six policies; executable composition adds five
   engine policies. This is a verifier representation defect, not an established
   production cohort mismatch. The bounded test correction names both expectations
   from the same cohort, verifies discovery's exact pair and the durable current
   release's exact executable pair, and validates this newly published version's
   canonical executable envelope/checksum against its admission release. Historical
   versions are not reinterpreted against a new current release. Ten projection
   regressions plus the twelve precision regressions pass **22/22**, rejecting
   swapped projections, wrong cohorts, epochs and same-epoch forged fingerprints.
   Submitted, schema-validated IDs/timestamps now log before SQL verification with
   an explicit **submitted/unverified** label; qualification logs only after SQL
   passes. Remaining receipt/event/audit/column assumptions were checked against
   implementation source, not qualified against that removed database. At that
   checkpoint corrected durable qualification still required review and a
   separately authorized invocation.

   The final independently reviewed single invocation **passed**: API **1/1**,
   Chromium **1/1**, 87.59s total / 85.47s API test, with unchanged case limits
   and no automatic retries. Log:
   `/tmp/pertexo-schedule-projections.fneKoY/schedule-live.log`. The browser exercised
   real authenticated preview, saved/reloaded 2×2 nested authoring, publication,
   database-clock observation before due, worker-runtime restart, natural scheduled
   admission, eight succeeded nodes, four scoped item/ordinal outputs, immutable
   version display and explicit disable before the second occurrence. The parent
   SQL verifier passed the catalog/current executable pairs and immutable
   executable envelope/checksum, exact original-three/raw-six instant, one
   version/run/occurrence/checkpoint, final disabled schedule with cleared lease,
   the three exact publication/scheduled-admission/disable receipts, queued/started/
   succeeded events once each, publication/disable audits and completed trigger
   reconciliation. No manual run-start request or manual admission audit occurred.

   Verified workspace `01a0e7c9-3bcf-7409-98f8-277c07544748`, workflow
   `01a0e7c9-3dd9-73a0-9ef8-8c19b51a048a`, version
   `01a0e7c9-7652-73f5-ae8e-fd1c66ad9dc5`, trigger
   `01a0e7c9-7659-713c-8f81-5818b6a0b6bf`, run
   `01a0e7ca-61f5-749c-8d60-bd6bca487e44`, occurrence
   `01a0e7ca-61fd-72bc-ab3a-e2b3df986abd`, restart request
   `5dce7eb6-0d5c-4e08-bd86-928f08d5fedb`. Original due
   `2026-09-28T11:33:15.163Z`; raw history `2026-09-28T11:33:15.163000Z`.
   Early disposable database
   `pertexo_test_ba_editor_browser_b76b1d0fd4f142ad8d09fc5a0d2a9ac6`, OID **260616**,
   was removed by normal teardown. Immediate exact owned-service/URL/OID checks
   in `preflight.json` and `cleanup.json` in that log directory preserved older
   OIDs **172428/186635/175980**, verified DB11 empty/DB10 lease absent, port 4174
   free and no fixture children. No older database or shared service was removed.

   This closes only the bounded local schedule gate. Restart was of owned worker
   runtime composition, **not an OS-process crash**. Two scanners prove observed
   composition, **not deterministic contention**. Controlled HTTP action,
   external provider/OIDC, production infrastructure and Firefox/WebKit gates
   remain open; F00/F01 are not complete. No commit or push occurred during this
   qualification. The preliminary wrapper parse error accessed no services and
   did not consume a live invocation; corrected literal quoting and added Redis
   loopback/protocol checks passed syntax-only review before actual preflight.

3. **Webhook → mapping/branch → actual controlled local action.** This remains
   gated on a concrete transport/envelope proposal: the present API fixture
   intentionally rejects credential writes/provider calls, and its pure worker
   cannot silently be reused as an external-action runtime. Inspect and compose
   the existing direct-webhook API fixture and the worker
   `http-node-attempt.runtime.ts` transport injection seam. The latter's default
   byte-producing response is a test double, not acceptable connected evidence.
   Propose one exact test-owned logical destination mapped by an isolated
   transport adapter to one owned loopback server; reject every other
   destination, preserve SecureHttpClient validation, and never relax production
   private-address egress or use real provider/customer credentials. Capture
   real server request/body/effect counts and return its actual response through
   the adapter. Browser authors/publishes/provisions the existing webhook with
   test-owned encryption keys; exercise authenticated ingress, validation/map,
   both branch outcomes and accepted immutable version. Lose an acknowledgement
   only after its actual commit and prove exact retry does not duplicate the
   run/action effect. Review webhook replay semantics separately from node
   external-delivery uncertainty; do not invent an exactly-once provider promise.
   Declare injected DNS/transport limits explicitly: this qualifies controlled
   local composition, not production network/provider interoperability.

   **Concrete controlled HTTP proposal — test-only implementation prepared;
   connected live qualification remains gated.** Source inspection after the
   accepted schedule checkpoint:

   - Add one separate `webhook-controlled-http` browser case using the existing
     owned Better Auth/API/worker harness, default 60s case / 180s parent and zero
     retries. Do not rerun the accepted schedule/other journeys. Preserve exact
     owned container/port/URL checks, UUID database/early OID and exclusive Redis
     DB11/DB10 lease discipline; never invoke the old HTTP fixture's DB14 default.
   - Use `validate_activation` consistently for browser catalog, API authoring,
     worker registry and composed database admission. Source inspection and the
     pure recipe check found that `webhook_activation` (epoch 22) predates
     `core.validate`; the existing `validate_activation` (epoch 38) retains the
     webhook/HTTP definitions and includes Validate. This bounded test-only
     correction was approved before implementation; no production release policy
     changes. Activate HTTP capabilities/configuration/cleanup using the explicit
     `webhook-controlled-http` scenario, not the cohort (other scenarios already
     use this cohort). Verify separate exact catalog/executable fingerprints and epoch,
     and assert required webhook/validate/map/branch/HTTP definitions publishable
     before browser work. Do not silently select the existing proof runtime's
     `email_activation` cohort.
   - Compose the actual `ApiWebhookRuntime` at the existing injected dependency
     seam (`app.ts`/`AppModule`), with real trigger persistence, management service,
     ingress/checkpoint factory and purpose-correct `WebhookTriggerEnvelopeEncryption`.
     `direct-webhook.integration.test.ts` demonstrates these concrete pieces, but
     its seeded graph/mock identity is not the browser journey. Fixture-local
     random envelope keys must stay in owned process memory/private child IPC,
     never Vite variables, logs or a persistent file. Same-purpose connection
     encryption must use `ConnectionEnvelopeEncryption`, not webhook envelopes.
     Reuse the real Better Auth identity, ordinary permissions and public connection
     creation routes. The current pure-node fixture explicitly rejects credential
     writes; enable only this scenario's real encrypted persistence. Unrelated
     scenarios stay fail-closed. Build one real trigger reconciliation runtime,
     register its capability once and wait for actual consumer/runtime readiness.
     Unlike schedule runtime creation, webhook automatic composition requires
     identity plus `config.webhooks` and is not suppressed merely by a custom
     workspace database. Explicit runtime injection here replaces only AWS/test
     key provisioning; it is not a correction to that production condition.
   - Worker source seams are `createPlatformNodeRegistryForRelease`,
     `createWorkerNodeRuntimeCapabilities` with real worker connection resolution/
     dispatch evidence, and `SecureHttpClient` resolver/transport injection from
     `http-node-attempt.runtime.ts`. Do not import that fixture wholesale: its
     default response is fabricated 70,000-byte output, its activation differs
     and its database/queue setup owns a separate environment. Own any added
     capability/connection resources immediately and close them after attempts
     drain, before namespace release; partial setup/failed close must preserve
     the uncertain fixture just like existing lifetime rules.
   - Exact test logical destination proposal:
     `https://pertexo-controlled-action.example.test/effect`, POST only, no query,
     no redirect (`maxRedirects:0`). Inject DNS only for that exact hostname with
     one public test address; retain `SecureHttpClient` URL/header/public-address
     checks and the committed `beforeDispatch` barrier. A narrow test transport
     admits only the exact URL/method/resolved address and maps that one request
     to a dynamically bound, recorded `127.0.0.1` server. Forward actual bounded
     request bytes/allowed headers with abort/deadline handling; expose the actual
     server status, headers and async body stream with once-owned close. Reject
     every other target before opening a socket, including redirects and private
     addresses. This is a deliberate test transport boundary, not real public
     DNS, TLS or production SSRF-network proof. No production address-policy
     change, real provider credential or arbitrary outbound destination.
   - Browser performs ordinary signup/sign-in/workspace/workflow creation, creates
     a test HTTP-header connection through existing UI, authors webhook → validate/
     map → branch → HTTP with existing controls, saves/reloads and publishes one
     immutable version. Provision through existing authenticated UI and explicitly
     acknowledge the transient endpoint/secret result. The fixture sender retains
     only its test-owned transient credentials; never print them. Existing live
     Playwright config already disables traces/screenshots/video; inspect final
     non-secret UI only. Both branch outcomes use signed raw JSON with distinct
     sender keys: true reaches exactly one real target effect; false skips the
     action. Verify mapped request body at the actual server, returned output in
     authorized run details and immutable version in both runs.
   - Lost acknowledgement concerns **ingress acceptance**, not HTTP action
     replay. An owned one-shot proxy forwards the signed request to real ingress,
     observes upstream 202 and verifies its committed run before dropping the
     downstream acknowledgement. Retry the original raw bytes/key (fresh signature
     timestamp allowed by ADR 026); actual ingress must return the same run with
     `replayed:true`, not create another run/action. Changed bytes/same key must
     return 409. Record attributed replay delivery metadata according to ADR 045,
     rather than expecting only one delivery row across multiple HTTP attempts.
     Provision replay does not redisclose credentials; do not lose that command's
     acknowledgement or invent secret recovery.
   - HTTP execution is explicitly `unsafe` (ADR 007). A provider-response loss is
     a different boundary: do not auto-retry that action or promise exactly-once
     external effects. Keep it out of this acceptance-replay case; report any
     attempted ambiguity truthfully as `outcome_unknown`. The server's observed
     effect count plus durable completed attempt/node/run facts qualify only the
     controlled successful execution and ingress replay.
   - Before live authorization: focused transport target-rejection, actual body/
     streamed response, abort/late response/close, partial-startup ownership and
     proxy post-commit-loss regressions; actual fixture API registration/CSRF/
     permissions/credential-envelope tests. Review exact browser recipe, SQL
     version/run/receipt/delivery/dispatch/audit assertions and cleanup command
     before one owned invocation. Correlate server effect observations with
     verified run/version/trigger IDs and keep submitted/unverified identities
     separate from final SQL success. Mocked transport tests alone cannot close
     the gate. Provider/OIDC, real DNS/TLS/egress and cross-browser evidence remain
     explicitly outstanding.

   **Pre-live implementation evidence (2026-09-28).** The isolated scenario now
   composes actual webhook management/ingress, purpose-separated authenticated
   envelope encryption, worker connection resolution and the existing secure
   HTTP client through a single test-owned server/transport. A one-shot ingress
   proxy observes upstream acceptance and verifies the committed run before
   dropping its acknowledgement; it does not fabricate a successful response.
   The browser recipe authors all five nodes with existing controls, provisions
   and acknowledges transient webhook material, exercises both branches and
   checks immutable versions and actual returned HTTP output. This recipe has
   been discovered but **not executed**. Proposed final SQL checks correlate
   publication/provision receipts, accepted delivery IDs (not sender keys),
   initial queued-event receipts (not continuation events), attributed replay
   deliveries, actual dispatch bindings and one observed target effect. SQL
   assertions have been source-audited but **not run**.

   Scoped checks:

   - Filtered API package script with four exact files: shared Node envelope
     tests **2/2**, then API release/encryption/control/proxy tests **12/12**
     across four files (574ms). Shared tests execute once in the existing API
     unit lane; the unchanged CI services-package loop calls that script, and
     root recursive test discovery includes that workspace once. No browser
     dependency is introduced into the ordinary unit lane.
   - Worker controlled transport, actual failed-reporter redaction and cleanup:
     **23/23**, three files (480ms). Earlier focused lifetime composition also
     passed; neither result proves live external delivery or an OS crash.
   - Actual Chromium/Playwright failed-reporter probe: **1/1**, 1.27s; its two
     deliberate child failures omit randomized credential, endpoint and
     signature material and Playwright call logs. This browser-required probe
     belongs to the existing required browser-probes CI lane, not API units.
   - The narrow production webhook key-validation correction maps only the
     existing parser's invalid-key error to `request.invalid`/400. Real local
     HTTP guard regressions cover provision and both rotations with missing and
     malformed keys: session/CSRF/tenant guards retain precedence, invalid keys
     never dispatch, valid commands do and unexpected service failures stay
     500. Focused webhook checks **17 passed/47 skipped**, two files, 2.13s;
     independent review reran them successfully. No persistence involved.
   - API/worker/web typechecks, scoped ESLint, architecture checks **19/19**,
     standard Knip and `git diff --check` passed. Browser list discovery confirms
     exactly one controlled-HTTP recipe; listing is not execution.

   An incorrectly forwarded `test -- <files>` command unexpectedly ran 122 API
   unit files: **1,616 passed / 1 failed** (the newly exposed older-cohort
   assumption). It accessed no live fixture/services; it is not presented as an
   intentional acceptance gate and was not repeated. Correctly forwarded
   focused package-script arguments passed after the approved cohort correction.
   Full connected PostgreSQL/worker/browser SQL evidence still requires review
   and explicit authorization for one owned invocation. Everyday API/database,
   external providers/OIDC, real DNS/TLS and Firefox/WebKit remain untouched and
   unverified by this slice. F00/F01 remain incomplete. No commit or push.

### Controlled HTTP connected qualification accepted (2026-09-28)

The reviewed v6 source passed **1/1 API integration and 1/1 Chromium**: API suite
33.99s (test 31.83s), browser 23.3s (suite 23.8s), unchanged 60s browser budget,
zero retries and 180s parent budget. Log and immediate owned pre/postflight:
`/tmp/pertexo-controlled-http-live-v6.I5KkDn/{live.log,preflight.json,cleanup.json}`.
The preceding pre-live statements above are historical, not the current gate.

The browser registered/verified/signed in using local application-owned mail,
created a real HTTP-header connection, authored/saved/reloaded five nodes and
four edges, then published/provisioned through ordinary cookie/CSRF contracts.
The one-shot proxy dropped ingress acknowledgement only after actual acceptance
and durable commit. Exact signed retry recovered the same run; changed payload
with the same key conflicted; a distinct false-branch command produced a second
run without dispatching HTTP. Both runs use one immutable version.

Verified identities:

- Workspace `01a0e8e1-ea7d-73ae-b51a-b1704589570f`;
  workflow `01a0e8e1-ee66-72c0-9580-801a467bdf20`.
- Version `01a0e8e2-2dd8-76d2-ad02-3a754b73531a`;
  trigger `01a0e8e2-2de0-71dd-9fd5-9fbb541efbcf`;
  connection `01a0e8e1-ec5c-72b7-a060-84978d17a9fb`.
- True run `01a0e8e2-3587-723a-9e90-1320452c7c7e`;
  false run `01a0e8e2-3941-722b-b17c-56a757a271ef`.

The full current `verifyHttpEvidence` ran successfully: version graph/checksum
and catalog/executable release projections, draft equality, both terminal runs,
checkpoints and queued/started/succeeded events, initial outbox receipt,
request-attributed accepted/replayed/conflict deliveries, provision/publication/
acceptance receipts, publication audit and completed trigger reconciliation.
The actual worker's unsafe HTTP attempt recorded a provider-dispatch binding;
the controlled target observed **one request / one effect**, body SHA256
`0d6b788dbb316a012e0e239e86734e7d9ac9b94254f1570c62e48ecd342809ef`.
This is successful controlled dispatch and ingress replay evidence, **not**
exactly-once external effects or recovery after an unsafe provider response loss.

Early fixture `pertexo_test_ba_editor_browser_fd241cecead04c38858d0eb559cf602c`,
OID 271232, was normally removed. Postflight rechecked exact owned containers,
all eight role URLs, older diagnostic OIDs 172428/186635/175980 unchanged, Redis
DB11 empty, its actual DB10 lease absent and port 4174 free. Everyday API/DB,
older databases and DB12 were untouched.

Focused corrections before this run include ordinary-pointer foreground drawer
selection and explicit Setup-tab authoring. A full mocked author/save/reload/
publish recipe passed 1/1 Chromium (16.6s / suite 23.4s). The supported offline
command now builds the five-package catalog closure before collection; local
build/collection passed, not a fresh-install CI claim. Pinned Playwright 1.63.0
also saves ARIA failure snapshots independently of tracing: the live config now
disables them by default. An isolated dummy-secret control reproduced artifact
capture; the guarded parent probe passed **3/3**, 2.95s, inspecting reporter and
bounded temporary artifacts without printing secrets. API/web typechecks,
scoped lint and diff checks passed after that correction. Review snapshot v6:
39 files, patch SHA256
`419c914eb26bbe6ab160d17e05424e4f4c8a4f4cbc5cffbc6b0b139caa96e0c7`.

Local connected qualification is accepted; the release closure below records
the subsequent commits, PR merges and natural main checks. External OIDC/providers, real DNS/TLS/
egress, OS-process crash/deterministic scanner contention, production rollout and
Firefox/WebKit are not established by this gate. Do not rerun accepted journeys
merely to update documentation or claim those external obligations complete.

For each proposal: review the exact test-only diff and lifecycle/authorization
assertions, run only its narrow no-service checks, then obtain approval for one
owned live invocation. Recheck the task's exact containers/project/ports,
database URLs, lease and free browser port immediately beforehand; record real
IDs, outcomes and normal teardown. Stop on failure and diagnose before another
invocation. No stack reset, old database/DB12 deletion, broad cohort rerun or
automatic command replay. External provider/deployment and Firefox/WebKit gates
stay separate until access and explicit scope are available.

### Bounded release closure (2026-09-28)

The reviewed integration delivery merged through
[PR113](https://github.com/vigani1/pertexo/pull/113), followed by
[PR114](https://github.com/vigani1/pertexo/pull/114)'s safe fixture-cleanup
diagnostics. Exact main source is `65a7c58bc02a47df660c49106bd4d9e0c5f69456`.
Its one natural [main CI run](https://github.com/vigani1/pertexo/actions/runs/36481275342)
and [CodeQL run](https://github.com/vigani1/pertexo/actions/runs/36481275347)
completed successfully and were independently inspected. These are release
evidence, not additional live journeys. Earlier pending/failure entries above
are historical; do not erase their limits or repeat accepted qualification.

PR114 adds safe phase diagnostics, not a demonstrated root-cause fix for the
earlier intermittent cleanup failure. The older zero-success account-link
observation remains unresolved separately. External provider/OIDC, real DNS/TLS,
production infrastructure/load, Firefox/WebKit, OS-process crash and deterministic
scanner contention gates remain unverified. Only the bounded local/release scope
is closed; no production activation is authorized.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

No duplicate side effect on retry; nested 2×2 produces four scoped leaf completions; cancellation becomes terminal; workspace isolation; preserved draft on conflict; failed/empty/unavailable data distinguished.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

No new product features, broad speculative refactoring, blind reruns or production deployment.

## Rollout and rollback

No rollout change. Keep owned fixtures separate and remove only task-owned resources when evidence is retained.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Reliability and usable execution history are table stakes; feature count is not a release proof.

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions (exact source and inherited evidence above).
- [x] Bounded local qualification choices resolved; existing ADRs retained, no new production policy.
- [x] Contracts and failure/security model reviewed for the bounded local slices.
- [x] Backend behavior independently verified within the recorded owned fixtures.
- [x] Frontend behavior independently verified within the recorded local Chromium journeys.
- [x] Real local integrated acceptance evidence recorded; external/provider/cross-browser gates remain explicit.
- [x] Rollout/rollback and limitations documented; no production rollout authorized.
- [x] Scoped PR113/114 merged with required checks; exact natural main CI/CodeQL result independently inspected.

Evidence log (2026-09-28): baseline inspection followed by the bounded real
qualification ledgers above, culminating in the accepted controlled HTTP gate.
No external provider or production deployment verification. The bounded release
gate is closed by PR113/114 and the exact main checks above; external limits and
the separately unresolved observations remain open.

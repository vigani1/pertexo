# F54 — HTTP polling trigger

Status: accepted; slice 1 in progress. Parent:
[F21b, slice 2](21b-next-integrations.md). Decision:
[ADR 093](../adr/093-polling-triggers.md).

## What the builder does

Add an **HTTP Polling** trigger, configure a JSON feed, connect the next step,
and publish. The Triggers tab shows the first observation as pending until a
baseline is established. The first successful poll starts zero runs. Later,
each new item starts one run and is available as `item` in the trigger output.
Every new publication establishes a fresh baseline. Repairing a connection and
resuming the current publication keeps its place.

| Setting | Meaning |
| --- | --- |
| URL | Absolute GET URL for a JSON feed. Newest-first feeds start the oldest fetched new item first. |
| Interval | Whole minutes, using the schedule interval range of one minute through 30 days. First observation is due on activation. |
| Items path | Existing JSON path syntax selecting an array, including the root array. |
| Item key path | Existing JSON path syntax relative to each item. Selects an immutable, unique, non-empty string or finite number. String and number keys are distinct. |
| Connection | Optional workspace HTTP header or OAuth2 connection, with the same supported connection types and target checks as HTTP Request. |

The feed may return one JSON page or use a same-origin HTTP `Link` header with
`rel="next"`. Poll often enough to keep new items within the fetched head.
Items beyond the page or item caps can be missed, and a poll stops at a page
of already seen items. New items beyond that page can also be missed. An
evicted key can start a run again if it reappears.
The Triggers tab shows safe reasons for invalid data, denied navigation and
credentials that need attention.

## Implementation slices

Each slice is a separate PR that passes its package tests and the repository
checks. Slice 1 exercises the scanner with a fake fetch adapter. Slice 2 wires
HTTP into the worker. Slice 3 registers the trigger for publication and
ships it with pause behavior, trigger health and editor support.

### 1. Database, claim and scanner

- **Shared types.** Define the config schema and named interval limits in
  `workflow-model/src/triggers/polling.schemas.ts`, deriving the interval
  range from the existing schedule bounds after moving their ownership to a
  shared browser-safe definition. Carry the persisted polling kind and run
  source through the shared types and schemas used by admission and reads,
  including `packages/contracts/src/schemas/execution/runs.ts`.
- **Core.** Extend `workflowTriggerProjection` in
  `triggers/reconciliation/projection.ts` and
  `reconcileActiveWorkflowTriggers`, `retirePreviousResources` and
  `applyResourceDispositions` in `materialization.repository.ts`. Materialize
  an active trigger with a pending baseline and a due time from the database.
  Replaying reconciliation of the same version preserves its seen-set. Retire an old
  version with the existing resource lifecycle. Carry the new materialized
  kind and the `polling` run source through persisted run admission, trigger
  root selection and the shared run-input codec. Use the ordinary published
  checkpoint factory and `acceptWorkflowRun` in
  `runs/commands/acceptance/accept.ts` with `{ triggerId, nodeId, item }`.
- **Database.** Define the workspace-scoped polling row under
  `packages/database/src/schema/triggers/` and export it from `schema.ts`.
  Add its migration, row security, composite foreign key, due index and
  retirement/purge handling. Use a nullable `bytea[]` on the poll row to
  distinguish a pending baseline from a completed empty baseline. Store one
  32-byte hash per key in insertion order. Core owns `POLL_MAX_SEEN_KEYS`
  (1,000, ten times `POLL_MAX_ITEMS`) and evicts oldest recorded keys on
  append. Reobserving a seen key leaves its age unchanged. A bounded array
  keeps leasing and progress on one row and uses the same cleanup lifecycle.
  Extend the run source constraint in
  `schema/runs/workflow-runs.ts`. Extend the maintenance-only claiming seam used by
  `app.claim_due_trigger_schedules` with a bounded polling claim projection.
  Use the same database-time lease owner, token, expiry and `SKIP LOCKED`
  rules. Return only the claim identity and timing across workspaces. Read
  the seen-set and config under tenant scope. Keep schedule claims, occurrence
  history and next-run projections on their existing paths.
- **Core scanner.** Extend the scan in `schedule-scanner.store.ts`, reusing
  the claim and retirement protocol in `schedules/scanning/claims.repository.ts`
  and `schedules/retire.ts`. Keep a bounded budget for each kind and claim
  polling work only as it can be started within the lease. Add
  `triggers/polling/process-claim.ts` for fetch and admission. Follow the
  actorless tenant transaction precedent in `processScheduleClaim`. Use
  `lockWorkspaceRunAdmission`, then the current workflow/publication and
  poll-row locks. Verify publication, pause and live lease at every commit.
  Claim expiry or cancellation only retires the live token. A stale worker
  cannot write progress or health.
- **Core admission.** Compare the bounded fetched items against the claimed
  seen-set. Keep the first occurrence of each key. On baseline, record every
  distinct fetched key in reverse feed order in one fenced transaction and
  start zero runs. On later polls, process unseen candidates in reverse feed
  order. Commit
  the run, outbox and seen-set append together for each item. Use the
  deterministic command identity and request fingerprint of the published
  trigger and typed key. Check the existing request-only acceptance replay
  before preparing a new checkpoint, so a retained receipt covers an
  evicted key even if its payload has changed. On replay, record the key
  without another run or outbox event. Run quota or concurrency deferral
  stops the batch and leaves that item and the remaining candidates unseen.
  Use the existing capacity deferral/backoff semantics.

### 2. HTTP fetch adapter and worker wiring

- **Integrations.** Extract the secure single-page fetch and bounded JSON
  decode from `fetchPage` and `readPage` in
  `http/request/pagination/execute.ts`; keep `executePagination` using the
  same implementation. Reuse the next-link handling in
  `pagination/navigation.ts` and `pagination/link.ts`. The polling adapter
  accepts the seen-set, budget and abort signal and returns the ordered keyed
  items or a typed failure. Walk at most `POLL_MAX_PAGES` (five) and inspect
  at most `POLL_MAX_ITEMS` (100) on every poll, including baseline. Each
  inspected item counts toward the cap, including repeated keys. Inspect
  only the prefix that fits when a page crosses the item cap. Stop at a
  reached cap or end of traversal, or after a nonempty page whose inspected
  keys all belong to the claimed seen-set. The scanner owns the caps and
  passes them to the adapter. Use the shared JSON path parser and the typed
  canonical scalar key rules behind `resolveEventCoordinationKey` without
  invoking the expression evaluator for a configured path. Enforce
  the existing key, JSON and response byte limits. Share connection material
  handling and the OAuth2 renewal path in
  `http/request/execution/request-client.ts` and `oauth2-renewal.ts`.
  Validate each dispatch through the secure client, cap the whole fetch by
  the remaining lease and worker deadline, and keep navigation same-origin.
- **Worker.** Wire the fetch adapter in `createTriggerRuntime`
  (`apps/worker/src/triggers/trigger.runtime.ts`) and
  `triggerRuntimeProvider` (`apps/worker/src/transport/providers/triggers.ts`).
  Reuse `createNodeProviderHttpClient` in `providers/http-client.ts` with the
  HTTP Request address policy. Resolve credentials by workspace using the
  connection store and dispatch fence behind
  `createProviderConnectionRuntimeFactory` in `providers/connections.ts`.
  Share provider rate limiting, OAuth2 token service and the current-secret
  check before every dispatch. Compose the polling adapter independently of
  run-attempt state. Thread through the existing scan cancellation and cleanup.

### 3. Publication, pause, contracts and the editor

- **Workflow model and catalog.** Add `http.poll@1` to
  `WORKFLOW_TRIGGER_DEFINITIONS` in
  `packages/workflow-model/src/graph/triggers.ts`. Register the trigger
  definition and trigger output executor through
  `packages/integrations/src/http/polling/` and
  `packages/node-catalog/src/{catalog,server}.ts`, following
  `nodes-core/src/triggers/schedule/schedule.definition.ts`. The executor
  exposes accepted input. The scanner owns remote fetching.
- **Core pause.** Extract the pause-state write and audit from
  `triggers/pause/fold.repository.ts` for use by the poll failure operation.
  Preserve the completed-run fold. Store poll failure evidence on the
  workflow as an alternative to completed-run evidence, with the poll
  trigger and safe error code. Keep a consecutive poll failure count on the
  leased polling row and honor the effective workspace/workflow setting and
  threshold. Include runs started by polling in `failureStreakOutcome` in
  `workflow-model/src/triggers/failure-streak.ts`.
  A valid fetch clears the streak. Capacity deferrals, cancellation and stale
  claims add no failures. Confirmed auth loss after OAuth2 renewal, or a
  revoked/missing bound credential, pauses immediately. Reuse
  `createWorkflowAutoPauseStore` in
  `authoring/settings/auto-pause/workflow-auto-pause.store.ts` for resume.
  Compare the stored pause revision when updating the streak so resumed polls
  start a new streak without resetting their seen-set.
- **Contracts and API.** Extend the published trigger and auto-pause
  schemas in `packages/contracts/src/schemas/`, including
  `workflows/auto-pause.ts`. Model pause evidence
  as distinct run and poll cases while preserving the existing completed-run
  response. Carry poll status and safe reasons through the existing trigger
  health and workflow activation reads, including `readHealth` in
  `triggers/reconciliation/health.repository.ts`. The existing publish, read
  and resume routes carry the changes through their declarations, including
  `apps/api/src/workflow-authoring/settings/auto-pause.controller.ts`.
- **Web.** Use the catalog setup schema in
  `apps/web/src/features/workflow-editor/components/inspector/tabs/setup.tsx`
  for the fields, defaults and connection picker. Extend
  `workflow-settings/pages/workflow-triggers.tsx` and its published-trigger
  model with a polling card for baseline, next check and health.
  Update `components/settings/auto-pause-section.tsx` to link to the polling
  trigger when the pause has poll evidence. Explain publication's baseline
  behavior in the setup and repair flow. In setup, explain stable unique
  keys, the seen-set retention limit and how to choose an interval that
  keeps new items within the fetched head.

## Acceptance tests

### Slice 1

- With real workspace transactions and a fake fetch adapter, interrupt after
  fetch before admission and after the first committed item of a multi-item
  poll. Rescan and assert one run and one outbox delivery record per admitted
  item and the expected persisted seen-set. Force a rollback during item
  admission and assert that the run, outbox and seen-set append roll back
  together.
- Force run quota and concurrency deferrals. Assert that the deferred item
  and subsequent candidates stay unseen and have no runs, and a later poll
  accepts the remainder in reverse feed order.
- Exercise overlapping claims with an expired lease, publication change and
  pause during fetch. Assert that stale fetches write neither progress nor
  health. Verify that a workspace cannot read or update another's poll state.
- Baseline a nonempty feed and an empty feed, publish a new version and replay
  reconciliation. Check that baseline produces zero runs, reconciliation of
  the same publication keeps the seen-set and a new version takes a new
  baseline.
- Fill the seen-set, confirm oldest keys are evicted and confirm reobserving
  a retained key does not refresh its age. Replay an evicted key while its
  acceptance receipt remains, with a changed payload, and assert that it
  is recorded again with no second run or outbox event. Verify that it can
  start again after both the seen key and receipt are gone.
- Keep the existing schedule scanner, occurrence and next-run tests green.

### Slice 2

- Exercise page and item caps against a fake paginated feed, including an
  exact cap, a page larger than the remaining budget, a paginated baseline
  and early termination on a page of seen keys. Assert no request beyond the
  cap, no admission for items beyond the inspected head and one candidate
  per repeated key. Verify that a deleted previously seen item and reordered
  items in the fetched head allow new runs while retained keys stay deduped.
- Verify that malformed items and denied navigation produce safe failures
  with unchanged seen state. Run the HTTP Request pagination suite against
  the shared page fetch.

### Slice 3

- Simulate terminal auth loss and repeated non-auth failures. Verify
  immediate auth pause, threshold pause for other failures, audited evidence,
  and resume through the normal workflow command without a fabricated run.
  Verify that resume preserves the seen-set, and that credential repair, a
  successful fetch and a separate run-based pause each preserve their
  expected behavior.
- Publish HTTP Polling through the editor against the test feed, verify its
  health in the Triggers tab, add an item, and inspect the downstream step's
  input.

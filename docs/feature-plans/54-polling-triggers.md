# F54 — HTTP polling trigger

Status: proposed for design review. Parent:
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
| URL | Absolute GET URL for a stable newest-first JSON feed. |
| Interval | Whole minutes, using the schedule interval range of one minute through 30 days. First observation is due on activation. |
| Items path | Existing JSON path syntax selecting an array, including the root array. |
| Item key path | Existing JSON path syntax relative to each item. Selects an immutable, unique, non-empty string or finite number. String and number keys are distinct. |
| Connection | Optional workspace HTTP header or OAuth2 connection, with the same supported connection types and target checks as HTTP Request. |

The feed may return one JSON page or use a same-origin HTTP `Link` header with
`rel="next"`. During traversal it must provide a stable view of the range
from its head to the last committed item. Items must stay visible until picked
up, including during capacity deferrals or pauses. Show a specific health
reason when the position is missing, a limit is reached, a key is invalid or
credentials need attention. If the position is gone permanently, publishing
again starts fresh from the current feed.

## Implementation slices

### Trigger definition and publication

- **Workflow model and catalog.** Add `http.poll@1` to
  `WORKFLOW_TRIGGER_DEFINITIONS` in
  `packages/workflow-model/src/graph/triggers.ts`. Put the shared config
  schema and named interval limits in `workflow-model/src/triggers/polling.schemas.ts`,
  deriving the interval range from the existing schedule bounds after moving
  their ownership to a shared browser-safe definition. Register the trigger
  definition and trigger output executor through
  `packages/integrations/src/http/polling/` and
  `packages/node-catalog/src/{catalog,server}.ts`, following
  `nodes-core/src/triggers/schedule/schedule.definition.ts`. The executor
  exposes accepted input. The scanner owns remote fetching.
- **Core.** Extend `workflowTriggerProjection` in
  `triggers/reconciliation/projection.ts` and
  `reconcileActiveWorkflowTriggers`, `retirePreviousResources` and
  `applyResourceDispositions` in `materialization.repository.ts`. Materialize
  an active trigger with a pending baseline and a due time from the database.
  Replaying
  reconciliation of the same version preserves its cursor. Retire an old
  version with the existing resource lifecycle. Carry the new materialized
  kind and the `polling` run source through persisted run admission, trigger
  root selection and the shared run-input codec. Use the ordinary published
  checkpoint factory and `acceptWorkflowRun` in
  `runs/commands/acceptance/accept.ts` with `{ triggerId, nodeId, item }`.
- **Database.** Define the workspace-scoped polling row under
  `packages/database/src/schema/triggers/` and export it from `schema.ts`.
  Add its migration, row security, composite foreign key, due index and
  retirement/purge handling. Extend the run source constraint in
  `schema/runs/workflow-runs.ts`. Extend the maintenance-only claiming seam used by
  `app.claim_due_trigger_schedules` with a bounded polling claim projection.
  Use the same database-time lease owner, token, expiry and `SKIP LOCKED`
  rules. Return only the claim identity and timing across workspaces. Read
  cursor and config under tenant scope. Keep schedule claims, occurrence
  history and next-run projections on their existing paths.

### Fetch and admission

- **Integrations.** Extract the secure single-page fetch and bounded JSON
  decode from `fetchPage` and `readPage` in
  `http/request/pagination/execute.ts`; keep `executePagination` using the
  same implementation. Reuse the next-link handling in
  `pagination/navigation.ts` and `pagination/link.ts`. The polling adapter
  accepts the current position, budget and abort signal and returns a
  proven range with a position per item, a baseline, or a typed failure.
  Retrieve only the head on baseline, and walk at most `POLL_MAX_PAGES`
  (five) and inspect at most `POLL_MAX_ITEMS` (100) after baseline.
  Apply the item cap to the baseline page as well. Count all fetched items
  against the cap and fail if a fetched page exceeds the remaining item budget. At an exact cap, succeed only if the boundary
  or required end is already proven. Use the shared JSON path parser and the
  typed canonical scalar key rules behind `resolveEventCoordinationKey`
  without invoking the expression evaluator for a configured path. Reject
  repeated keys within the candidate range as a feed contract violation. Enforce
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
- **Core scanner.** Extend the scan in `schedule-scanner.store.ts`, reusing
  the claim and retirement protocol in `schedules/scanning/claims.repository.ts`
  and `schedules/retire.ts`. Keep a bounded budget for each kind and claim
  polling work only as it can be started within the lease. Add
  `triggers/polling/process-claim.ts` for fetch and admission. Follow the
  actorless tenant transaction precedent in `processScheduleClaim`. Use
  `lockWorkspaceRunAdmission`, then `lockEventCoordination`, then current
  workflow/publication and poll-row locks. Verify the lease at each commit.
  Claim expiry or cancellation only retires the live token. A stale worker
  cannot write progress or health. On a successful prefix followed by a
  crash, a replacement claim reads that prefix and starts at its successor.
- **Core coordination.** Share `loadEventWindow`, `chargeEventWindow` and
  `decideEventCoordination` with the existing deduplication path. Use the
  published trigger identity in the policy fingerprint and the standard
  deduplication window. A charged live key in that scope was admitted.
  Share the window and outbox transaction with per-item position advancement.
  Use a deterministic admission command identity for the same published
  trigger and typed item key. A full key budget, run quota or concurrency
  limit defers at the first unaccepted item. Preserve the position and use
  the existing capacity deferral/backoff semantics. Polling creates no
  pending debounce or throttle events.

### Pause, contracts and the editor

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
  start a new streak without resetting their position.
- **Contracts and API.** Extend the published trigger, run source and
  auto-pause schemas in `packages/contracts/src/schemas/`, including
  `execution/runs.ts` and `workflows/auto-pause.ts`. Model pause evidence
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
  behavior in the setup and repair flow.

## Acceptance tests

- With real workspace transactions and a fake HTTP feed, interrupt after
  fetch before admission and after the first committed item of a multi-item
  poll. Rescan and assert one run and one outbox delivery record per admitted
  item and the expected persisted position. Force a rollback during item
  admission and assert that run, key charge, outbox and position roll back
  together.
- Force run quota, concurrency and key-budget deferrals in a multi-item
  poll. Assert that the cursor never passes the first unaccepted item, later
  items have no runs, and a later poll accepts the remainder in order.
- Exercise overlapping claims with an expired lease, publication change and
  pause during fetch. Assert that stale fetches write neither progress nor
  health. Verify that a workspace cannot read or update another's poll state.
- Baseline a nonempty feed and an empty feed, publish a new version, replay
  reconciliation and resume after a pause. Check that baseline produces zero
  runs, same-version resume retains progress, and first publication of a new
  version takes a new baseline.
- Prove the page and item caps against a fake paginated feed, including
  exact-cap completion, a missing boundary, malformed items and a denied
  navigation target. Assert a safe health result and unchanged cursor when
  the range cannot be proven. Run the HTTP Request pagination suite against
  the shared page fetch.
- Simulate terminal auth loss and repeated non-auth failures. Verify
  immediate auth pause, threshold pause for other failures, audited evidence,
  and resume through the normal workflow command without a fabricated run.
  Verify that credential repair, a successful fetch, and a separate run-based
  pause each preserve their expected behavior.
- Publish HTTP Polling through the editor against the test feed, verify its
  health in the Triggers tab, add an item, and inspect the downstream step's
  input. Keep the existing schedule scanner, occurrence and next-run tests
  green.

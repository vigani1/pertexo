# Complexity Hotspot Retention Register

Recorded: 2026-09-03

This historical register records the occurrences accepted after the A-06 refactor on the date above. Current accepted occurrences and ceilings are owned by [the executable baseline](../../infrastructure/complexity-baseline.json); subsequent removals and refactors are recorded in [the structure audit](../repository-structure-audit.md). The original measurements below are not current file sizes or permission to restore removed allowances. A baseline entry is permission not to worsen measured debt, not permission to add behavior or raise the baseline; remove it when a verified refactor brings it within budget.

## File hotspots

| File | Lines | Retention reason |
| --- | ---: | --- |
| `apps/api/src/connections/use-cases.ts` | 575 | Connection use cases share authorization, credential, and provider-test policy. Three post-external-work abort checks intentionally prevent persistence after request cancellation; retain pending a focused feature-local split. |
| `apps/api/src/identity-infrastructure/oidc-adapter.ts` | 507 | OIDC discovery, callback, token, and identity validation remain one security boundary; retain to preserve validation order. |
| `apps/worker/src/execution/node-runtime-capabilities.ts` | 503 | Historical allowance; the Q06 follow-up reduced this file to 421 lines by extracting the provider-connection runtime with cancellation, fencing, credential and redelivery characterization. |
| `apps/worker/src/execution/preview-attempt-handler.ts` | 534 | Worker attempt or transport lifecycle composition remains local; split only with cancellation, fencing, and redelivery characterization. |
| `apps/worker/src/transport/outbox-dispatcher.ts` | 538 | Worker attempt or transport lifecycle composition remains local; split only with cancellation, fencing, and redelivery characterization. |
| `packages/artifact-store/src/control-ledger.ts` | 997 | Append-only ledger integrity and replay rules share one owner; splitting requires hash-chain and concurrency characterization. |
| `packages/artifact-store/src/store.ts` | 903 | Artifact streaming, metadata, checksum, and storage lifecycle share one adapter boundary; split only with object-store integration evidence. |
| `packages/database/src/connections/connection-persistence.ts` | 652 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/lifecycle/control-ledger-coordinator.ts` | 1048 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/execution/coordinator-run-store-observations.ts` | 729 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/execution/dispatcher.ts` | 508 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/execution/execution-acceptance.ts` | 547 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/execution/failure-notification-destinations.ts` | 633 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/tenant-access/identity-workspace.ts` | 591 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/platform/postgres-telemetry.ts` | 541 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/lifecycle/preview-cleanup.ts` | 548 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/execution/preview-execution-acceptance.ts` | 563 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/lifecycle/retention.ts` | 813 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/triggers/schedule-triggers.ts` | 662 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/triggers/webhook-triggers.ts` | 666 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/authoring/workflow-authoring.ts` | 624 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/execution/workflow-run-api.ts` | 517 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/triggers/workflow-triggers.ts` | 503 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/lifecycle/workspace-lifecycle-commands.ts` | 559 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/database/src/lifecycle/workspace-purge.ts` | 798 | Capability-owned PostgreSQL composition or transaction surface; retain until a focused change can preserve SQL ordering, connection ownership, and atomicity with real-service characterization. |
| `packages/integrations/src/http/secure-http.ts` | 808 | Deliberately linear SSRF/DNS/TLS/redirect validation sequence; leave intact unless profiling or a correctness defect justifies a seam. |
| `packages/node-catalog/src/registry.ts` | 767 | Catalog assembly and compatibility validation share one registry owner and generated manifest boundary. |
| `packages/node-sdk/src/release.ts` | 846 | Canonical release grammar, fingerprinting, and successor validation share one compatibility boundary. |
| `packages/node-sdk/src/server.ts` | 954 | Registry HTTP boundary keeps validation, compatibility headers, and response contracts local; split only with server contract characterization. |
| `packages/queue/src/consumer.ts` | 685 | Consumer lease, shutdown, redelivery, and acknowledgement lifecycle is one stateful adapter boundary. |
| `packages/workflow-engine/src/coordinator-observations.ts` | 540 | Cohesive scheduler/state-machine validation surface; retain to keep transition ordering local and refactor only with public-boundary characterization. |
| `packages/workflow-engine/src/operations.ts` | 731 | Cohesive scheduler/state-machine validation surface; retain to keep transition ordering local and refactor only with public-boundary characterization. |
| `packages/workflow-engine/src/workflow-transition-observations.ts` | 528 | Cohesive scheduler/state-machine validation surface; retain to keep transition ordering local and refactor only with public-boundary characterization. |
| `packages/workflow-model/src/expressions.ts` | 673 | Canonical expression grammar and the worker lifecycle supervisor remain colocated. The ready-to-start handoff now stays under the startup deadline and rejects invalid worker message order; retain to keep that timing state machine reviewable in one owner. |
| `packages/workflow-model/src/graph.ts` | 927 | Canonical graph/expression grammar and validation boundary; retain to keep one source of truth for parsing and normalization. |

## Function hotspots

| Function | Lines | Branches | Retention reason |
| --- | ---: | ---: | --- |
| `apps/api/src/webhooks/ingress.ts#acceptWebhook` | 214 | 32 | Webhook admission keeps verification, authorization, persistence, and reply sequencing explicit in one security-sensitive path. |
| `apps/worker/src/execution/node-attempt-handler.ts#createNodeAttemptHandler` | 329 | 3 | Attempt lifecycle handler keeps lease, cancellation, execution, and acknowledgement ordering visible; retain under public behavior tests. |
| `apps/worker/src/execution/node-attempt-handler.ts#handle` | 314 | 31 | Attempt lifecycle handler keeps lease, cancellation, execution, and acknowledgement ordering visible; retain under public behavior tests. |
| `apps/worker/src/execution/preview-attempt-handler.ts#createPreviewAttemptHandler` | 258 | 3 | Attempt lifecycle handler keeps lease, cancellation, execution, and acknowledgement ordering visible; retain under public behavior tests. |
| `apps/worker/src/execution/preview-attempt-handler.ts#handle` | 243 | 11 | Attempt lifecycle handler keeps lease, cancellation, execution, and acknowledgement ordering visible; retain under public behavior tests. |
| `packages/database/src/connections/connection-management-persistence.ts#createConnectionManagementPersistence` | 284 | 0 | Database capability factory owns private SQL methods and transaction policy; retain until a focused split has real PostgreSQL characterization. |
| `packages/database/src/connections/connection-secret-persistence.ts#createConnectionSecretPersistence` | 269 | 0 | Database capability factory owns private SQL methods and transaction policy; retain until a focused split has real PostgreSQL characterization. |
| `packages/database/src/connections/connection-test-persistence.ts#createConnectionTestPersistence` | 430 | 0 | Database capability factory owns private SQL methods and transaction policy; retain until a focused split has real PostgreSQL characterization. |
| `packages/database/src/lifecycle/control-ledger-coordinator.ts#createControlLedgerCoordinator` | 578 | 4 | Database capability factory owns private SQL methods and transaction policy; retain until a focused split has real PostgreSQL characterization. |
| `packages/database/src/execution/coordinator-run-store-commit-state.ts#lockCoordinatorCommitState` | 208 | 34 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/execution/coordinator-run-store-observations.ts#loadCoordinatorAdvanceState` | 276 | 0 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/execution/coordinator-run-store-observations.ts#<ArrowFunction:1>` | 263 | 37 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/execution/dispatcher.ts#createOutboxDispatcherDatabase` | 288 | 0 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/execution/execution-acceptance.ts#acceptWorkflowRun` | 203 | 16 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/execution/failure-notification-destinations.ts#createFailureNotificationDestinationDatabase` | 284 | 0 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/tenant-access/identity-workspace.ts#createIdentityWorkspaceDatabase` | 209 | 0 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/execution/node-attempt-run-store-claim.ts#claimNodeAttemptDelivery` | 219 | 3 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/execution/node-attempt-run-store-inputs.ts#loadNodeAttemptInputs` | 303 | 2 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/execution/node-attempt-run-store-inputs.ts#<ArrowFunction:3>` | 264 | 43 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/operator/operator-commands.ts#createOperatorCommandDatabase` | 230 | 0 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/compatibility/persisted-workflow-checkpoint.ts#<ArrowFunction:16>` | 142 | 44 | Authoritative scheduler/checkpoint state-machine decision; ordering is correctness-sensitive and section 19.4 excludes speculative decomposition. |
| `packages/database/src/execution/preview-execution-reconciliation.ts#reconcilePreviewDelivery` | 277 | 4 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/execution/preview-execution-reconciliation.ts#<ArrowFunction:4>` | 236 | 22 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/lifecycle/retention.ts#createRetentionDatabase` | 374 | 0 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/triggers/schedule-triggers.ts#createScheduleTriggerDatabase` | 218 | 0 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/triggers/webhook-triggers.ts#createWebhookTriggerDatabase` | 352 | 1 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/triggers/workflow-triggers.ts#createWorkflowTriggerReconciliationDatabase` | 317 | 0 | Composition factory owns private method closures and one connection policy; low branch count shows size rather than decision complexity, so retain until that capability changes. |
| `packages/database/src/triggers/workflow-triggers.ts#reconcile` | 279 | 2 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/triggers/workflow-triggers.ts#<ArrowFunction:1>` | 265 | 33 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/database/src/lifecycle/workspace-lifecycle-commands.ts#createWorkspaceLifecycleCommandCoordinator` | 243 | 0 | Database capability factory owns private SQL methods and transaction policy; retain until a focused split has real PostgreSQL characterization. |
| `packages/database/src/lifecycle/workspace-purge.ts#createWorkspacePurgeCoordinator` | 584 | 1 | Database capability factory owns private SQL methods and transaction policy; retain until a focused split has real PostgreSQL characterization. |
| `packages/database/src/lifecycle/workspace-purge.ts#processNext` | 533 | 19 | Single PostgreSQL transaction or mapped persistence operation; retain to preserve lock, query, and commit ordering until a separately reviewed extraction. |
| `packages/node-sdk/src/server.ts#createNodeRegistry` | 287 | 22 | Registry construction keeps compatibility selection and immutable release validation in one public boundary. |
| `packages/observability/src/transport-metrics.ts#createTransportMetrics` | 216 | 1 | Metrics factory centralizes bounded-cardinality instruments and adapter methods; low branch count makes further splitting low value. |
| `packages/workflow-engine/src/checkpoint-v1-join.ts#parseJoin` | 201 | 41 | Versioned checkpoint grammar decision remains atomic at the parser boundary; existing golden/public tests guard it and code-audit section 19.4 says to leave parser semantics alone. |
| `packages/workflow-engine/src/checkpoint-v1-loop.ts#parseLoop` | 222 | 25 | Versioned checkpoint grammar decision remains atomic at the parser boundary; existing golden/public tests guard it and code-audit section 19.4 says to leave parser semantics alone. |
| `packages/workflow-engine/src/checkpoint-v1.ts#parseCheckpointV1Boundary` | 272 | 39 | Versioned checkpoint grammar decision remains atomic at the parser boundary; existing golden/public tests guard it and code-audit section 19.4 says to leave parser semantics alone. |
| `packages/workflow-engine/src/coordinator-observations.ts#forEachCoordinatorObservations` | 220 | 44 | Authoritative scheduler/checkpoint state-machine decision; ordering is correctness-sensitive and section 19.4 excludes speculative decomposition. |
| `packages/workflow-engine/src/graph-scheduler.ts#deriveReadyNodes` | 202 | 35 | Authoritative scheduler/checkpoint state-machine decision; ordering is correctness-sensitive and section 19.4 excludes speculative decomposition. |
| `packages/workflow-engine/src/operations.ts#assertCheckpointMatchesExecutable` | 178 | 42 | Authoritative scheduler/checkpoint state-machine decision; ordering is correctness-sensitive and section 19.4 excludes speculative decomposition. |

## Focused Q07 connection-persistence review

Reviewed 2026-09-09. The production consumers already cross the smallest
existing capability interfaces; the broad database is retained for internal
composition and database integration fixtures, not injected into either
production runtime.

| Consumer role | Interface and factory | Actual consumer | SQL owner |
| --- | --- | --- | --- |
| API connection commands | `ConnectionManagementDatabase` plus `ConnectionTestDatabase`; `createApiConnectionDatabase` owns `close` | `apps/api/src/connections/ports.ts` and `apps/api/src/platform/connections/connection-runtime.module.ts` | Management, secret-rotation, and connection-test persistence modules |
| Worker credential use | `ConnectionResolutionDatabase`; `createWorkerConnectionResolutionDatabase` owns `close` | `apps/worker/src/execution/provider-connection-runtime.ts`, composed by `node-runtime-capabilities.ts` | Resolution persistence plus the current-secret assertion in secret persistence |
| Database compatibility and lifecycle fixtures | `ConnectionDatabase`; `createConnectionDatabase` | Database and composed worker integration support only | All five focused persistence modules through the same composed pool lease |

`connection-persistence.ts` is already a feature-local neutral leaf: it imports
no composing factory or child persistence module and owns the shared contracts,
validation, row/durable-result codecs, authorization queries, and tenant
transaction wrapper used by multiple connection capabilities. Moving those
pieces into separate contract, codec, and transaction files would make the five
SQL owners learn several internal interfaces without reducing production caller
knowledge or introducing a second adapter. The deletion test therefore favors
retention. Role-specific SQL stays in the focused child modules, public package
exports stay unchanged, and the composing factory remains the only pool owner.
This decision changes no query, transaction, lock order, connection demand, or
runtime path.

## Focused Q08 destructive-orchestration review

Reviewed 2026-09-09 against the executable scanner rather than the historical
tables above.

| Symbol | Current | Executable allowance | Disposition |
| --- | ---: | ---: | --- |
| `connections/connection-persistence.ts` | 651 lines | 651 | Retain per Q07; production interfaces are already narrower than the shared implementation vocabulary. |
| `lifecycle/workspace-purge.ts` | 872 lines | 873 | Retain the transaction/advisory-lock/ledger/object-store sequence in one owner. |
| `workspace-purge.ts#createWorkspacePurgeCoordinator` | 632 lines / 5 branches | 636 / 5 | Size is private method composition, not added decision complexity. |
| `workspace-purge.ts#processNext` | 525 lines / 45 branches | 530 / 45 | Keep the three durable state paths visibly ordered; the current symbol is below its line allowance and has not added a branch. |
| `lifecycle/control-ledger-coordinator.ts` | 926 lines | 926 | Retain the bounded reconcile/append/project state machine. |
| `control-ledger-coordinator.ts#createControlLedgerCoordinator` | 596 lines / 4 branches | 596 / 4 | Retain the single pool and ledger authority. |
| `artifact-store/src/control-ledger.ts` | 910 lines | 910 | Owns immutable canonical records, hash-chain verification, append, and bounded reconciliation. |
| `artifact-store/src/store.ts` | 986 lines | 986 | Owns physical S3 version/delete-marker listing, bounded deletion, and exact acknowledgement validation. |
| `artifact-store/src/dual-region-artifact-store.ts` | 391 lines | 500-line budget | Owns parallel primary/recovery purge and rejects unavailable or divergent outcomes. |

The selected public operation is `WorkspacePurgeCoordinator.processNext`.
Its stage and authority map is:

| Stage | Authority and owner | Lifetime / failure rule |
| --- | --- | --- |
| Discover and observe | Workspace-purge coordinator calls the maintenance-only due functions, locks the PostgreSQL control anchor in a short transaction, then asks the artifact control-ledger owner to reconcile to that exact high water. | No external I/O occurs under the discovery transaction; unrelated or incomplete ledger state fails closed. |
| Claim | The coordinator acquires the workspace-scoped session advisory lock, re-locks and compares the control anchor, then invokes the fenced PostgreSQL claim in a short transaction. | The advisory lock spans the destructive operation; the transaction does not. A legal hold, concurrent claim, or changed anchor produces no destructive call. |
| Physical object I/O | The dual-region artifact-store owner calls both regional stores. Each regional `store.ts` implementation lists at most the requested object versions and delete markers, issues the bounded version-aware delete, and verifies every acknowledgement. | Partial/unavailable or divergent regional results throw. Retrying the same page is required because a provider error can follow physical deletion. |
| Fence and checkpoint | Still under the advisory lock, the coordinator opens a new transaction, re-locks the anchor, checks the immutable high-water value and step token/fence, and checkpoints only the validated page result. | A newly projected hold waits for the session lock; stale leases and changed control fences cannot checkpoint. |
| Release, retry, and completion | On a claimed-step failure the coordinator invokes the lease-fenced release; expired or replaced ownership is unchanged. Durable discovery reclaims expired work. Completion separately prepares, reconciles/appends the deletion record, verifies its bytes/hash, and projects it in short fenced transactions. | Release is compare-and-set, append ambiguity is repaired by command identity, and restart resumes from PostgreSQL plus the immutable ledger rather than process memory. |

The public-operation evidence matrix is complete after adding one missing real
PostgreSQL stale-step regression:

| Required case | Evidence |
| --- | --- |
| Hold arrival during physical deletion | `retention-artifacts.integration.test.ts` starts deletion through the public run-artifact coordinator and proves legal-hold projection waits on the shared workspace advisory lock; the workspace-purge integration separately proves a held step performs no object I/O. |
| Stale step lease and concurrent claim/release | `workspace-purge-foundation.integration.test.ts` expires a crashed object-step lease, proves its release and checkpoint are fenced, then runs two public coordinators and observes one physical purge with a monotonic reclaim fence. Its existing concurrent-start test proves one claim and one idle result after an ambiguous append release. |
| Partial or ambiguous external deletion, checkpoint retry, and restart | The workspace-purge integration retries after deletion succeeds before checkpointing and repairs ambiguous completion append; artifact-store single- and dual-region suites reject partial acknowledgements, unavailable regions, and divergent page results. |
| Cancellation during advisory-lock or pool acquisition | `retention-artifacts.integration.test.ts` exercises the shared public destructive-operation seam against real PostgreSQL and proves prompt connection destruction/no leaked lock; workspace-purge cancellation tests prove no follow-on discovery or object I/O. |
| Transaction lifetime during external I/O | `workspace-purge-foundation.integration.test.ts` pauses object erasure and observes zero open maintenance transactions while the session advisory lock remains authoritative. |

No production extraction follows from this review. The current module is deep:
two public methods hide three restartable durable state paths, while keeping the
ordering facts a caller must not reconstruct in one implementation. Splitting
claim, ledger I/O, physical I/O, fence, and release into shallow orchestration
helpers would move correctness knowledge without removing it. The added test
uses disposable pools only; production query count, pool ownership and demand,
lock order, and external-I/O concurrency are unchanged.

## Verification

`node infrastructure/validate-complexity.mjs` re-inventories all production TypeScript and fails for a new or worsened hotspot. At this register revision it reports 35 file and 40 function hotspots with no regression. The database testing entry point fell from 567 to 85 physical lines after its exact exports were delegated to capability-owned testing barrels.

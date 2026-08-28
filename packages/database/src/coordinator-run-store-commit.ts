import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  coordinatorDeliverySchema,
  coordinatorIdentitySchema as identitySchema,
  type CommitAdvancePlanInput,
  type CommitAdvancePlanResult,
  type CoordinatorAdvanceDelivery,
} from './coordinator-run-store-contract.js';
import {
  auditCoordinatorDeliveryMismatch,
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
  deferCoordinatorForActiveCapacity,
  DeliveryMismatch,
  validateAuthoritativeAdvanceDelivery,
} from './coordinator-run-store-delivery.js';
import {
  canonicalTimestamp,
  mapEvent,
  maximumPersistedFacts,
  persistedFactCapacity,
  readPersistedFacts,
  record,
  terminalStatus,
  validatePersistedFactBatch,
} from './coordinator-run-store-observations.js';
import {
  allowedRunTransitions,
  parseTransitionPlan,
  scheduleRunInputSchema,
  terminalRunStatuses,
  traceparentSchema,
  transitionFingerprint,
  validateCheckpointOutputOwnership,
  validateStatusTransitions,
  validateTransitionDelta,
  validateTransitionPlan,
} from './coordinator-run-store-plan.js';
import {
  persistDueReadyTransitions,
  persistLoopBarrierTransitions,
} from './coordinator-run-store-settlement.js';
import { persistFailureNotificationIntent } from './coordinator-run-store-terminal.js';
import {
  assertCoordinatorNotAborted as assertNotAborted,
  withCoordinatorWriteClient as withWorkspaceWriteClient,
} from './coordinator-run-store-transactions.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  parsePersistedPhase3Checkpoint,
  serializePersistedPhase3Checkpoint,
  type PersistedPhase3Checkpoint,
} from './phase3-checkpoint.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from './stored-execution-value.js';

export async function commitCoordinatorAdvancePlan(
  pool: Pool,
  input: CommitAdvancePlanInput,
): Promise<CommitAdvancePlanResult> {
  if (!(input.signal instanceof AbortSignal))
    throw new CoordinatorPlanInvalidError();
  assertNotAborted(input.signal);
  let workspaceId: string;
  let runId: string;
  let workflowVersionId: string;
  let traceparent: string | undefined;
  let delivery: CoordinatorAdvanceDelivery;
  try {
    workspaceId = identitySchema.parse(input.workspaceId);
    runId = identitySchema.parse(input.runId);
    workflowVersionId = identitySchema.parse(input.workflowVersionId);
    traceparent = traceparentSchema.parse(input.traceparent);
    delivery = coordinatorDeliverySchema.parse(input.delivery);
  } catch {
    throw new CoordinatorPlanInvalidError();
  }
  const plan = parseTransitionPlan(input.plan);
  validateTransitionPlan(plan, workflowVersionId);
  const checkpointJson = serializePersistedPhase3Checkpoint(plan.checkpoint);
  const planFingerprint = transitionFingerprint({
    plan,
    traceparent,
    workflowVersionId,
  });
  try {
    const transactionResult = await withWorkspaceWriteClient(
      pool,
      workspaceId,
      input.signal,
      async (client) => {
        await validateAuthoritativeAdvanceDelivery(
          client,
          workspaceId,
          runId,
          delivery,
        );
        const locked = await client.query<{
          revision: number;
          scheduler_state: unknown;
          last_transition_fingerprint: string | null;
          workflow_version_id: string;
          status: string;
          cancel_requested_at: Date | null;
          deadline_expired: boolean;
          workflow_id: string;
          trigger_type: string;
          started_at: Date | null;
          created_at: Date;
          failure_notification_policy_version: number | null;
          failure_notification_destination_id: string | null;
          failure_notification_destination_config_version: number | null;
          failure_notification_side_effect_class: string | null;
          execution_entitlement_version: number;
          input_ref: unknown;
        }>(
          `select checkpoint.revision, checkpoint.scheduler_state,
                    checkpoint.last_transition_fingerprint,
                    checkpoint.workflow_version_id, run.status,
                    run.cancel_requested_at,
                     run.workflow_id,run.trigger_type,run.started_at,run.created_at,
                     run.failure_notification_policy_version,
                     run.failure_notification_destination_id,
                     run.failure_notification_destination_config_version,
                     run.failure_notification_side_effect_class,
                     run.execution_entitlement_version,run.input_ref,
                     run.deadline_at is not null
                      and run.deadline_at <= clock_timestamp() as deadline_expired
             from app.workflow_runs run
             join app.run_checkpoints checkpoint
               on checkpoint.workspace_id = run.workspace_id
              and checkpoint.workflow_run_id = run.id
             where run.workspace_id = $1 and run.id = $2
             for update of run, checkpoint`,
          [workspaceId, runId],
        );
        const row = locked.rows[0];
        if (row === undefined) return Object.freeze({ kind: 'not_found' });
        if (row.workflow_version_id !== workflowVersionId)
          throw new CoordinatorPlanInvalidError();
        if (row.revision !== plan.expectedRevision) {
          if (
            row.revision === plan.expectedRevision + 1 &&
            row.last_transition_fingerprint === planFingerprint &&
            serializeStoredExecutionJsonValue(row.scheduler_state) ===
              checkpointJson
          ) {
            const receipt = await claimCoordinatorReceipt(
              client,
              workspaceId,
              delivery,
            );
            if (receipt === 'new')
              await completeCoordinatorReceipt(client, workspaceId, delivery);
            return Object.freeze({
              kind: 'already_committed',
              revision: row.revision,
            });
          }
          return Object.freeze({ kind: 'stale', revision: row.revision });
        }
        let currentCheckpoint: PersistedPhase3Checkpoint;
        try {
          currentCheckpoint = parsePersistedPhase3Checkpoint(
            row.scheduler_state,
          );
        } catch {
          throw new CoordinatorRunStateCorruptError();
        }
        if (
          currentCheckpoint.workflowVersionId !== workflowVersionId ||
          currentCheckpoint.revision !== row.revision ||
          currentCheckpoint.runStatus !== row.status ||
          currentCheckpoint.nextEventSequence !== plan.expectedNextEventSequence
        )
          throw new CoordinatorRunStateCorruptError();
        validateTransitionDelta(currentCheckpoint, plan);
        if (
          !allowedRunTransitions[currentCheckpoint.runStatus]?.has(
            plan.checkpoint.runStatus,
          )
        )
          throw new CoordinatorPlanInvalidError();
        const highWaterResult = await client.query<{ high_water: number }>(
          `select coalesce(max(sequence), 0)::int as high_water
             from app.run_events
             where workspace_id = $1 and workflow_run_id = $2`,
          [workspaceId, runId],
        );
        if (
          highWaterResult.rows[0]?.high_water !==
          plan.consumedThroughEventSequence
        )
          return Object.freeze({ kind: 'stale', revision: row.revision });
        const expectedPersistedFactCount = Math.max(
          0,
          plan.consumedThroughEventSequence -
            currentCheckpoint.nextEventSequence +
            1,
        );
        const factCapacity = await persistedFactCapacity(
          client,
          workspaceId,
          runId,
          currentCheckpoint.nextEventSequence,
          plan.consumedThroughEventSequence,
        );
        if (factCapacity.count !== expectedPersistedFactCount)
          return Object.freeze({ kind: 'stale', revision: row.revision });
        if (factCapacity.count > maximumPersistedFacts)
          throw new CoordinatorRunStateCorruptError();
        const persistedFacts = await readPersistedFacts(client, {
          count: factCapacity.count,
          firstSequence: currentCheckpoint.nextEventSequence,
          lastSequence: plan.consumedThroughEventSequence,
          runId,
          workspaceId,
        });
        if (persistedFacts.length !== expectedPersistedFactCount)
          return Object.freeze({ kind: 'stale', revision: row.revision });
        validatePersistedFactBatch(persistedFacts);
        const pendingFailures = await client.query<{
          attempt_id: string;
          attempt_number: number;
          executor_error_kind: string;
          executor_failure_kind: string;
          executor_possibly_dispatched: boolean;
          invocation_key: string;
          safe_error_code: string;
        }>(
          `select attempt.id attempt_id,attempt.attempt_number,
                      attempt.executor_failure_kind,attempt.executor_error_kind,
                      attempt.executor_possibly_dispatched,attempt.safe_error_code,
                      node.invocation_key
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and node.workflow_run_id=$2
                 and node.current_attempt_id=attempt.id
                 and node.status='running' and attempt.status='failed'
                 and attempt.retry_decision='pending'
               order by node.invocation_key,attempt.id
               for update of node,attempt`,
          [workspaceId, runId],
        );
        validateStatusTransitions(currentCheckpoint, plan, [
          ...persistedFacts.map((fact) => ({
            invocationKey: fact.invocation_key,
            observation: record(mapEvent(fact)),
            type: fact.type,
          })),
          ...pendingFailures.rows.map((failure) => ({
            invocationKey: failure.invocation_key,
            type: 'attempt_failure',
            observation: record({
              kind: 'attempt_failure',
              attemptId: failure.attempt_id,
              attemptNumber: failure.attempt_number,
              failureKind: failure.executor_failure_kind,
              errorKind: failure.executor_error_kind,
              possiblyDispatched: failure.executor_possibly_dispatched,
              safeErrorCode: failure.safe_error_code,
            }),
          })),
        ]);
        if (
          (currentCheckpoint.cancelRequested &&
            row.cancel_requested_at === null) ||
          (currentCheckpoint.deadlineExpired && !row.deadline_expired)
        )
          throw new CoordinatorRunStateCorruptError();
        const authoritativeCancellation =
          currentCheckpoint.cancelRequested || row.cancel_requested_at !== null;
        const authoritativeDeadline =
          currentCheckpoint.deadlineExpired || row.deadline_expired;
        if (
          plan.checkpoint.cancelRequested !== authoritativeCancellation ||
          plan.checkpoint.deadlineExpired !== authoritativeDeadline
        ) {
          if (
            (!plan.checkpoint.cancelRequested && authoritativeCancellation) ||
            (!plan.checkpoint.deadlineExpired && authoritativeDeadline)
          )
            return Object.freeze({ kind: 'stale', revision: row.revision });
          throw new CoordinatorPlanInvalidError();
        }
        if (
          row.status === 'queued' &&
          (plan.checkpoint.runStatus === 'running' ||
            plan.checkpoint.runStatus === 'waiting')
        ) {
          const deferred = await deferCoordinatorForActiveCapacity(client, {
            workspaceId,
            runId,
            revision: row.revision,
            entitlementVersion: row.execution_entitlement_version,
            delivery,
            ...(traceparent === undefined ? {} : { traceparent }),
          });
          if (deferred !== undefined) return deferred;
        }
        await validateCheckpointOutputOwnership(
          client,
          workspaceId,
          runId,
          plan.checkpoint,
          new Set(
            plan.attempts
              .filter(({ admissionKind }) => admissionKind === 'wait_resume')
              .map(({ invocationKey }) => invocationKey),
          ),
        );
        await persistLoopBarrierTransitions(
          client,
          workspaceId,
          runId,
          currentCheckpoint,
          plan.checkpoint,
        );
        await persistDueReadyTransitions(
          client,
          workspaceId,
          runId,
          currentCheckpoint,
          plan.checkpoint,
        );
        assertNotAborted(input.signal);
        const receipt = await claimCoordinatorReceipt(
          client,
          workspaceId,
          delivery,
        );
        if (receipt === 'duplicate')
          return Object.freeze({
            kind: 'already_committed' as const,
            revision: row.revision,
          });

        const invocations = new Map(
          plan.checkpoint.invocations.map((invocation) => [
            invocation.invocationKey,
            invocation,
          ]),
        );
        const physical = new Map<
          string,
          { nodeRunId: string; attemptId?: string; attemptNumber?: number }
        >();
        for (const failure of pendingFailures.rows) {
          const event = plan.events.find(
            (candidate) =>
              candidate.invocationKey === failure.invocation_key &&
              [
                'node.retry_scheduled',
                'node.failed',
                'node.canceled',
                'node.timed_out',
                'node.outcome_unknown',
              ].includes(candidate.name),
          );
          const invocation = invocations.get(failure.invocation_key);
          if (event === undefined || invocation === undefined)
            throw new CoordinatorPlanInvalidError();
          const decision =
            event.name === 'node.retry_scheduled'
              ? 'retry'
              : event.name.slice('node.'.length);
          if (
            ![
              'retry',
              'failed',
              'canceled',
              'timed_out',
              'outcome_unknown',
            ].includes(decision)
          )
            throw new CoordinatorPlanInvalidError();
          const finalized = await client.query(
            `update app.node_attempts set retry_decision=$3,updated_at=clock_timestamp()
                 where workspace_id=$1 and id=$2 and retry_decision='pending'`,
            [workspaceId, failure.attempt_id, decision],
          );
          if (finalized.rowCount !== 1)
            throw new CoordinatorRunStateCorruptError();
          const nodeStatus = decision === 'retry' ? 'waiting' : decision;
          const updated = await client.query(
            `update app.node_runs
                 set status=$4::varchar,retry_due_at=$5,resume_at=null,
                     wait_kind=case when $4::varchar='waiting' then 'retry_backoff' else null end,
                     due_wakeup_at=null,
                     completed_at=case when $4::varchar='waiting' then null else clock_timestamp() end,
                     safe_error_code=$6,updated_at=clock_timestamp()
                 where workspace_id=$1 and workflow_run_id=$2
                   and invocation_key=$3 and current_attempt_id=$7
                   and status='running'`,
            [
              workspaceId,
              runId,
              failure.invocation_key,
              nodeStatus,
              decision === 'retry' ? event.dueAt : null,
              failure.safe_error_code,
              failure.attempt_id,
            ],
          );
          if (updated.rowCount !== 1)
            throw new CoordinatorRunStateCorruptError();
        }
        for (const admission of plan.nodeRunAdmissions) {
          const invocation = invocations.get(admission.invocationKey);
          if (invocation === undefined) throw new CoordinatorPlanInvalidError();
          const attempt = plan.attempts.find(
            ({ invocationKey }) => invocationKey === admission.invocationKey,
          );
          const nodeRunId = randomUUID();
          const attemptId = attempt === undefined ? undefined : randomUUID();
          await client.query(
            `insert into app.node_runs (
                  id, workspace_id, workflow_run_id, node_id, invocation_key,
                  branch_context, status, side_effect_class, provider_idempotency_key,
                  current_attempt_id, current_attempt_number, completed_at
                ) values (
                  $1,$2,$3,$4,$5,$6::jsonb,$7::varchar,$8,$9,$10,$11,
                  case when $7::varchar = 'skipped' then clock_timestamp() else null end
                )`,
            [
              nodeRunId,
              workspaceId,
              runId,
              admission.nodeId,
              admission.invocationKey,
              serializeStoredExecutionJsonValue({
                ...('branchPath' in invocation &&
                invocation.branchPath !== undefined
                  ? { branchPath: invocation.branchPath }
                  : {}),
                ...('iterationPath' in invocation &&
                invocation.iterationPath !== undefined
                  ? { iterationPath: invocation.iterationPath }
                  : {}),
              }),
              invocation.status === 'pending'
                ? 'pending'
                : invocation.status === 'skipped'
                  ? 'skipped'
                  : 'ready',
              admission.sideEffectClass,
              admission.providerIdempotencyKey ?? null,
              attemptId ?? null,
              attempt?.attemptNumber ?? null,
            ],
          );
          physical.set(admission.invocationKey, {
            nodeRunId,
            ...(attemptId === undefined || attempt === undefined
              ? {}
              : { attemptId, attemptNumber: attempt.attemptNumber }),
          });
        }

        for (const attempt of plan.attempts) {
          let ids = physical.get(attempt.invocationKey);
          if (ids === undefined) {
            const existing = await client.query<{
              id: string;
              current_attempt_number: number | null;
              provider_idempotency_key: string | null;
              side_effect_class: string;
              status: string;
              is_due: boolean;
            }>(
              `select id, current_attempt_number, side_effect_class,
                        provider_idempotency_key, status,
                        coalesce(retry_due_at, resume_at) is not null
                          and coalesce(retry_due_at, resume_at) <= clock_timestamp()
                          as is_due
                 from app.node_runs
                 where workspace_id = $1 and workflow_run_id = $2
                   and invocation_key = $3
                 for update`,
              [workspaceId, runId, attempt.invocationKey],
            );
            const node = existing.rows[0];
            const isFirstReadyAttempt =
              (node?.status === 'ready' || node?.status === 'pending') &&
              (node.current_attempt_number === null
                ? attempt.attemptNumber === 1
                : node.current_attempt_number === attempt.attemptNumber - 1);
            const isDueAttempt =
              node?.status === 'waiting' &&
              node.is_due &&
              node.current_attempt_number === attempt.attemptNumber - 1;
            if (
              node?.side_effect_class !== attempt.sideEffectClass ||
              node.provider_idempotency_key !==
                (attempt.providerIdempotencyKey ?? null) ||
              (!isFirstReadyAttempt && !isDueAttempt)
            )
              throw new CoordinatorPlanInvalidError();
            ids = {
              nodeRunId: node.id,
              attemptId: randomUUID(),
              attemptNumber: attempt.attemptNumber,
            };
            physical.set(attempt.invocationKey, ids);
            await client.query(
              `update app.node_runs
                 set status='ready', current_attempt_id=$1,
                      current_attempt_number=$2, resume_at=null,
                       retry_due_at=null, due_wakeup_at=null, wait_kind=null,
                       updated_at=clock_timestamp()
                 where workspace_id=$3 and id=$4`,
              [
                ids.attemptId,
                attempt.attemptNumber,
                workspaceId,
                ids.nodeRunId,
              ],
            );
          }
          if (ids.attemptId === undefined)
            throw new CoordinatorPlanInvalidError();
          await client.query(
            `insert into app.node_attempts (
                   id, workspace_id, node_run_id, attempt_number, status,
                   side_effect_class, provider_idempotency_key, admission_kind
                 ) values ($1,$2,$3,$4,'ready',$5,$6,$7)`,
            [
              ids.attemptId,
              workspaceId,
              ids.nodeRunId,
              attempt.attemptNumber,
              attempt.sideEffectClass,
              attempt.providerIdempotencyKey ?? null,
              attempt.admissionKind,
            ],
          );
          const outboxEventId = randomUUID();
          const payload = {
            schemaVersion: 1,
            workspaceId,
            runId,
            nodeRunId: ids.nodeRunId,
            attemptId: ids.attemptId,
            outboxEventId,
            ...(traceparent === undefined ? {} : { traceparent }),
          } as const;
          await client.query(
            `insert into app.outbox_events (
                 id, workspace_id, job_name, schema_version, aggregate_type,
                 aggregate_id, payload, payload_checksum
               ) values ($1,$2,'execute-node-attempt',1,'node-attempt',$3,$4::jsonb,$5)`,
            [
              outboxEventId,
              workspaceId,
              ids.attemptId,
              serializeStoredExecutionJsonValue(payload),
              canonicalOutboxPayloadChecksum(payload),
            ],
          );
        }

        const missingEventInvocationKeys = [
          ...new Set(
            plan.events.flatMap(({ invocationKey }) =>
              invocationKey === undefined || physical.has(invocationKey)
                ? []
                : [invocationKey],
            ),
          ),
        ];
        if (missingEventInvocationKeys.length > 0) {
          const existingNodes = await client.query<{
            id: string;
            invocation_key: string;
            current_attempt_id: string | null;
            current_attempt_number: number | null;
          }>(
            `select id, invocation_key, current_attempt_id,
                      current_attempt_number
               from app.node_runs
               where workspace_id=$1 and workflow_run_id=$2
                 and invocation_key=any($3::varchar[])
               for update`,
            [workspaceId, runId, missingEventInvocationKeys],
          );
          for (const node of existingNodes.rows)
            physical.set(node.invocation_key, {
              nodeRunId: node.id,
              ...(node.current_attempt_id === null
                ? {}
                : {
                    attemptId: node.current_attempt_id,
                    ...(node.current_attempt_number === null
                      ? {}
                      : { attemptNumber: node.current_attempt_number }),
                  }),
            });
          if (missingEventInvocationKeys.some((key) => !physical.has(key)))
            throw new CoordinatorRunStateCorruptError();
        }

        for (const event of plan.events) {
          const ids =
            event.invocationKey === undefined
              ? undefined
              : physical.get(event.invocationKey);
          const payload = {
            schemaVersion: event.schemaVersion,
            ...(event.invocationKey === undefined
              ? {}
              : { invocationKey: event.invocationKey }),
            ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
            ...(event.attemptNumber === undefined
              ? {}
              : { attemptNumber: event.attemptNumber }),
            ...(event.reasonCode === undefined
              ? {}
              : { reasonCode: event.reasonCode }),
            ...(event.dueAt === undefined ? {} : { dueAt: event.dueAt }),
            ...(ids === undefined ? {} : { nodeRunId: ids.nodeRunId }),
            ...(ids?.attemptId !== undefined &&
            ids.attemptNumber === event.attemptNumber
              ? { attemptId: ids.attemptId }
              : {}),
          };
          await client.query(
            `insert into app.run_events (
                 workspace_id, workflow_run_id, sequence, type, payload, created_at
               ) values ($1,$2,$3,$4,$5::jsonb,$6)`,
            [
              workspaceId,
              runId,
              event.sequence,
              event.name,
              serializeStoredExecutionJsonValue(payload),
              event.occurredAt,
            ],
          );
          const terminalNodeStatus = terminalStatus(event.name);
          if (
            terminalNodeStatus !== undefined &&
            event.invocationKey !== undefined &&
            !pendingFailures.rows.some(
              (failure) => failure.invocation_key === event.invocationKey,
            )
          ) {
            const updatedNode = await client.query(
              `update app.node_runs
                  set status=$1, completed_at=clock_timestamp(),
                        safe_error_code=$2, resume_at=null, retry_due_at=null,
                        due_wakeup_at=null, control_kind=null, wait_kind=null,
                     updated_at=clock_timestamp()
                 where workspace_id=$3 and workflow_run_id=$4
                   and invocation_key=$5
                   and status in ('pending','ready','waiting')`,
              [
                terminalNodeStatus,
                event.reasonCode ?? null,
                workspaceId,
                runId,
                event.invocationKey,
              ],
            );
            if (updatedNode.rowCount !== 1)
              throw new CoordinatorRunStateCorruptError();
          }
        }

        await persistFailureNotificationIntent(client, {
          workspaceId,
          runId,
          workflowId: row.workflow_id,
          workflowVersionId,
          triggerType: row.trigger_type,
          startedAt: row.started_at,
          createdAt: row.created_at,
          policyVersion: row.failure_notification_policy_version,
          destinationId: row.failure_notification_destination_id,
          destinationConfigVersion:
            row.failure_notification_destination_config_version,
          sideEffectClass: row.failure_notification_side_effect_class,
          cancellationRequested: authoritativeCancellation,
          plan,
          ...(traceparent === undefined ? {} : { traceparent }),
        });

        const checkpointUpdate = await client.query(
          `update app.run_checkpoints
             set revision=$1, engine_version=$2, scheduler_state=$3::jsonb,
                 last_transition_fingerprint=$7,
                 resume_at=null, resume_lease_owner=null,
                 resume_lease_token=null, resume_lease_expires_at=null,
                 updated_at=clock_timestamp()
             where workspace_id=$4 and workflow_run_id=$5 and revision=$6`,
          [
            plan.checkpoint.revision,
            plan.checkpoint.engineVersion,
            checkpointJson,
            workspaceId,
            runId,
            plan.expectedRevision,
            planFingerprint,
          ],
        );
        if (checkpointUpdate.rowCount !== 1)
          throw new CoordinatorRunStateCorruptError();
        const startedAt = plan.events.find(
          ({ name }) => name === 'run.started',
        )?.occurredAt;
        let scheduleDueAt: string | undefined;
        if (startedAt !== undefined && row.trigger_type === 'schedule') {
          const storedInput = parseStoredExecutionValueV1(row.input_ref);
          if (storedInput.kind !== 'inline')
            throw new CoordinatorRunStateCorruptError();
          const scheduleInput = scheduleRunInputSchema.safeParse(
            storedInput.value,
          );
          if (!scheduleInput.success)
            throw new CoordinatorRunStateCorruptError();
          scheduleDueAt = canonicalTimestamp(scheduleInput.data.scheduledAt);
        }
        const completedAt = plan.events.find(
          ({ name }) =>
            name.startsWith('run.') && terminalRunStatuses.has(name.slice(4)),
        )?.occurredAt;
        await client.query(
          `update app.workflow_runs
             set status=$1,
                 started_at=coalesce(started_at,$2::timestamptz),
                 completed_at=case when $3::timestamptz is null
                   then completed_at else $3::timestamptz end,
                 updated_at=clock_timestamp()
             where workspace_id=$4 and id=$5`,
          [
            plan.checkpoint.runStatus,
            startedAt ?? null,
            completedAt ?? null,
            workspaceId,
            runId,
          ],
        );
        await completeCoordinatorReceipt(client, workspaceId, delivery);
        assertNotAborted(input.signal);
        return Object.freeze({
          kind: 'committed',
          revision: plan.checkpoint.revision,
          admittedAttempts: Object.freeze(
            plan.attempts.map(({ invocationKey }) => {
              const ids = physical.get(invocationKey);
              if (ids?.attemptId === undefined)
                throw new CoordinatorPlanInvalidError();
              return Object.freeze({
                invocationKey,
                nodeRunId: ids.nodeRunId,
                attemptId: ids.attemptId,
              });
            }),
          ),
          ...(scheduleDueAt === undefined ? {} : { scheduleDueAt }),
        });
      },
    );
    if (
      transactionResult.kind !== 'committed' ||
      !('scheduleDueAt' in transactionResult) ||
      typeof transactionResult.scheduleDueAt !== 'string'
    )
      return transactionResult;
    const { scheduleDueAt, ...committed } = transactionResult;
    try {
      const observed = await pool.query<{ observed_at: Date }>(
        'select clock_timestamp() observed_at',
      );
      const durableStartObservedAt = observed.rows[0]?.observed_at;
      if (durableStartObservedAt === undefined) return Object.freeze(committed);
      const scheduleToStartSeconds =
        (durableStartObservedAt.getTime() - Date.parse(scheduleDueAt)) / 1_000;
      return Object.freeze({
        ...committed,
        scheduleToStartSeconds,
      });
    } catch {
      return Object.freeze(committed);
    }
  } catch (error: unknown) {
    if (error instanceof DeliveryMismatch)
      return auditCoordinatorDeliveryMismatch(
        pool,
        workspaceId,
        delivery,
        input.signal,
      );
    throw error;
  }
}

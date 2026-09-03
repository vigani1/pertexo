import type { Pool } from 'pg';

import {
  CoordinatorPlanInvalidError,
  coordinatorDeliverySchema,
  coordinatorIdentitySchema as identitySchema,
  type CommitAdvancePlanInput,
  type CommitAdvancePlanResult,
  type CoordinatorAdvanceDelivery,
} from './coordinator-run-store-contract.js';
import { lockCoordinatorCommitState } from './coordinator-run-store-commit-state.js';
import {
  auditCoordinatorDeliveryMismatch,
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
  DeliveryMismatch,
} from './coordinator-run-store-delivery.js';
import { persistCoordinatorExecutionTransitions } from './coordinator-run-store-execution.js';
import {
  parseTransitionPlan,
  traceparentSchema,
  transitionFingerprint,
  validateCheckpointOutputOwnership,
  validateTransitionPlan,
} from './coordinator-run-store-plan.js';
import { persistCoordinatorRunTransition } from './coordinator-run-store-run-transition.js';
import {
  persistDueReadyTransitions,
  persistLoopBarrierTransitions,
} from './coordinator-run-store-settlement.js';
import {
  assertCoordinatorNotAborted as assertNotAborted,
  withCoordinatorWriteClient as withWorkspaceWriteClient,
} from './coordinator-run-store-transactions.js';
import { serializePersistedWorkflowCheckpoint } from '../compatibility/persisted-workflow-checkpoint.js';

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
  const checkpointJson = serializePersistedWorkflowCheckpoint(plan.checkpoint);
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
        const commitState = await lockCoordinatorCommitState(client, {
          checkpointJson,
          delivery,
          plan,
          planFingerprint,
          runId,
          ...(traceparent === undefined ? {} : { traceparent }),
          workflowVersionId,
          workspaceId,
        });
        if (commitState.kind === 'outcome') return commitState.result;

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
          commitState.currentCheckpoint,
          plan.checkpoint,
        );
        await persistDueReadyTransitions(
          client,
          workspaceId,
          runId,
          commitState.currentCheckpoint,
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
            revision: commitState.row.revision,
          });

        const physical = await persistCoordinatorExecutionTransitions(client, {
          pendingFailures: commitState.pendingFailures,
          plan,
          runId,
          ...(traceparent === undefined ? {} : { traceparent }),
          workspaceId,
        });
        const runTransition = await persistCoordinatorRunTransition(client, {
          authoritativeCancellation: commitState.authoritativeCancellation,
          checkpointJson,
          plan,
          planFingerprint,
          row: commitState.row,
          runId,
          ...(traceparent === undefined ? {} : { traceparent }),
          workflowVersionId,
          workspaceId,
        });
        await completeCoordinatorReceipt(client, workspaceId, delivery);
        assertNotAborted(input.signal);
        return Object.freeze({
          kind: 'committed' as const,
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
          ...runTransition,
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
      return Object.freeze({
        ...committed,
        scheduleToStartSeconds:
          (durableStartObservedAt.getTime() - Date.parse(scheduleDueAt)) /
          1_000,
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

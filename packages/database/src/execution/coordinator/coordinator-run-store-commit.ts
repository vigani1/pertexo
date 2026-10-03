import type { Pool } from 'pg';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';

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
  persistRejectedForEachDeclarations,
} from './coordinator-run-store-settlement.js';
import {
  assertCoordinatorNotAborted as assertNotAborted,
  withCoordinatorWriteClient as withWorkspaceWriteClient,
} from './coordinator-run-store-transactions.js';
import { serializeCoordinatorCheckpoint } from './coordinator-checkpoint.js';
import { observeScheduleToStartSeconds } from './coordinator-schedule-observation.js';
import {
  prepareCoordinatorCallAdmission,
  type CoordinatorCallAdmissionOptions,
} from './coordinator-call-admission.js';
import { persistCoordinatorCallTransitions } from './coordinator-call-transitions.js';
import { persistCoordinatorCallResult } from './coordinator-call-result.js';
import { authenticateCoordinatorCallResult } from './coordinator-call-result-authentication.js';

class NativeAdmissionPassAbandoned extends Error {
  public constructor(readonly result: CommitAdvancePlanResult) {
    super('Native admission pass requires rollback');
  }
}

export async function commitCoordinatorAdvancePlan(
  pool: Pool,
  input: CommitAdvancePlanInput,
  options: Readonly<{
    runTimeoutFailureContextEnabled: boolean;
    workspaceInboxProducerEnabled: boolean;
    workflowTriggerOutcomesEnabled: boolean;
    workflowCallAdmission?: CoordinatorCallAdmissionOptions;
    callableResultEvaluator?: ExpressionEvaluator;
  }>,
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
  // The native cohort stays OFF until its child-control persistence owner is
  // wired. Never acknowledge a cancellation plan while dropping its intent.
  if ((plan.workflowCalls?.cancelChildren.length ?? 0) > 0)
    throw new TypeError('Native child cancellation persistence is unavailable');
  const checkpointJson = serializeCoordinatorCheckpoint(plan.checkpoint);
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
        await authenticateCoordinatorCallResult(client, {
          workspaceId,
          runId,
          workflowVersionId,
          plan,
          signal: input.signal,
          ...(options.callableResultEvaluator === undefined
            ? {}
            : { expressionEvaluator: options.callableResultEvaluator }),
        });
        const callAdmission = await prepareCoordinatorCallAdmission(
          client,
          {
            workspaceId,
            runId,
            plan,
            ...(traceparent === undefined ? {} : { traceparent }),
          },
          options.workflowCallAdmission,
        );
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
        if (commitState.kind === 'outcome') {
          if (callAdmission !== undefined)
            throw new NativeAdmissionPassAbandoned(commitState.result);
          return commitState.result;
        }

        await validateCheckpointOutputOwnership(
          client,
          workspaceId,
          runId,
          commitState.currentCheckpoint,
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
        await persistRejectedForEachDeclarations(client, {
          workspaceId,
          runId,
          declarations: commitState.rejectedForEachDeclarations,
        });
        assertNotAborted(input.signal);
        const receipt = await claimCoordinatorReceipt(
          client,
          workspaceId,
          delivery,
        );
        if (receipt === 'duplicate') {
          const duplicate = Object.freeze({
            kind: 'already_committed' as const,
            revision: commitState.row.revision,
          });
          if (callAdmission !== undefined)
            throw new NativeAdmissionPassAbandoned(duplicate);
          return duplicate;
        }

        await callAdmission?.admit();
        await persistCoordinatorCallTransitions(client, {
          workspaceId,
          runId,
          current: commitState.currentCheckpoint,
          plan,
        });

        const physical = await persistCoordinatorExecutionTransitions(client, {
          pendingFailures: commitState.pendingFailures,
          rejectedForEachDeclarations: commitState.rejectedForEachDeclarations,
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
          runTimeoutFailureContextEnabled:
            options.runTimeoutFailureContextEnabled,
          workspaceInboxProducerEnabled: options.workspaceInboxProducerEnabled,
          workflowTriggerOutcomesEnabled:
            options.workflowTriggerOutcomesEnabled,
          runId,
          ...(traceparent === undefined ? {} : { traceparent }),
          workflowVersionId,
          workspaceId,
        });
        // Private transaction evidence for the native post-CAS seal must never
        // become part of the public commit result or transport authority.
        const {
          continuationOutboxEventId: _continuation,
          ...publicRunTransition
        } = runTransition;
        await persistCoordinatorCallResult(client, { runId, plan, delivery });
        await callAdmission?.seal(_continuation);
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
          ...publicRunTransition,
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
    const scheduleToStartSeconds = await observeScheduleToStartSeconds(
      pool,
      scheduleDueAt,
      input.signal,
    );
    return Object.freeze({
      ...committed,
      ...(scheduleToStartSeconds === undefined
        ? {}
        : { scheduleToStartSeconds }),
    });
  } catch (error: unknown) {
    if (error instanceof NativeAdmissionPassAbandoned) {
      if (error.result.kind === 'deferred') throw error;
      return error.result;
    }
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

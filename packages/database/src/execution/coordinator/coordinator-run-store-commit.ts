import { prepareCoordinatorAdvanceParameters } from './coordinator-advance-preparation.js';
import type { Pool } from 'pg';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';

import {
  CoordinatorPlanInvalidError,
  type CommitAdvancePlanInput,
  type CommitAdvancePlanResult,
} from './coordinator-run-store-contract.js';
import { lockCoordinatorCommitState } from './coordinator-run-store-commit-state.js';
import {
  auditCoordinatorDeliveryMismatch,
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
  DeliveryMismatch,
} from './coordinator-run-store-delivery.js';
import { persistCoordinatorExecutionTransitions } from './coordinator-run-store-execution.js';
import { validateCheckpointOutputOwnership } from './coordinator-run-store-plan.js';
import { persistCoordinatorRunTransition } from './coordinator-run-store-run-transition.js';
import { persistCoordinatorDeclarationTransitions } from './coordinator-run-store-settlement.js';
import {
  assertCoordinatorNotAborted as assertNotAborted,
  withCoordinatorWriteClient as withWorkspaceWriteClient,
} from './coordinator-run-store-transactions.js';
import { observeCommittedCoordinatorSchedule } from './coordinator-schedule-observation.js';
import {
  prepareCoordinatorCallAdmission,
  type CoordinatorCallAdmissionOptions,
} from './coordinator-call-admission.js';
import { persistCoordinatorCallTransitions } from './coordinator-call-transitions.js';
import { persistCoordinatorCallResult } from './coordinator-call-result.js';
import { persistCoordinatorCallControls } from './coordinator-call-controls.js';
import type {
  NativeCoordinatorResultPreparationScope,
  NativeCoordinatorControlSourceHydrator,
  InspectCoordinatorValueReadOwner,
  NativeCoordinatorCallDeclarationHydrator,
  NativeCoordinatorResultSourceHydrator,
  NativeCoordinatorResultValuePreparer,
} from './coordinator-native-value-read-contract.js';

class NativeAdmissionPassAbandoned extends Error {
  public constructor(readonly result: CommitAdvancePlanResult) {
    super('Native admission pass requires rollback');
  }
}

type CoordinatorAdvanceCommitOptions = Readonly<{
  runTimeoutFailureContextEnabled: boolean;
  workspaceInboxProducerEnabled: boolean;
  workflowTriggerOutcomesEnabled: boolean;
  workflowCallAdmission?: CoordinatorCallAdmissionOptions;
  callableResultEvaluator?: ExpressionEvaluator;
  nativeValueControlReadTimeoutMillis?: number;
  withNativeResultPreparation?: NativeCoordinatorResultPreparationScope;
  inspectNativeResultOwner?: InspectCoordinatorValueReadOwner;
  hydrateNativeCallDeclaration?: NativeCoordinatorCallDeclarationHydrator;
  hydrateNativeResultSources?: NativeCoordinatorResultSourceHydrator;
  hydrateNativeControlSource?: NativeCoordinatorControlSourceHydrator;
  prepareNativeResultValue?: NativeCoordinatorResultValuePreparer;
}>;

export async function commitCoordinatorAdvancePlan(
  pool: Pool,
  input: CommitAdvancePlanInput,
  options: CoordinatorAdvanceCommitOptions,
): Promise<CommitAdvancePlanResult> {
  const {
    workspaceId,
    runId,
    workflowVersionId,
    traceparent,
    delivery,
    plan,
    checkpointJson,
    planFingerprint,
    nativeResult,
    preparedResult,
    nativeControls,
    preparedControls,
  } = await prepareCoordinatorAdvanceParameters(pool, input, options);

  try {
    const transactionResult = await withWorkspaceWriteClient(
      pool,
      workspaceId,
      input.signal,
      async (client) => {
        const callAdmission = await prepareCoordinatorCallAdmission(
          client,
          {
            workspaceId,
            runId,
            plan,
            delivery,
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
          ...(preparedControls === undefined ? {} : { preparedControls }),
        });
        if (commitState.kind === 'outcome') {
          if (callAdmission !== undefined)
            throw new NativeAdmissionPassAbandoned(commitState.result);
          return commitState.result;
        }
        if (nativeResult && preparedResult === undefined)
          throw new Error(
            'Native result current precommit material is unavailable',
          );
        if (nativeControls && preparedControls === undefined)
          throw new Error(
            'Native control current precommit material is unavailable',
          );

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
          new Set(commitState.stoppedForEachDeclarations.keys()),
        );
        await persistCoordinatorDeclarationTransitions(client, {
          workspaceId,
          runId,
          current: commitState.currentCheckpoint,
          next: plan.checkpoint,
          rejected: commitState.rejectedForEachDeclarations,
          stopped: commitState.stoppedForEachDeclarations,
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
        await persistCoordinatorCallControls(client, {
          workspaceId,
          runId,
          plan,
          delivery,
          ...(traceparent === undefined ? {} : { traceparent }),
        });
        await persistCoordinatorCallTransitions(client, {
          workspaceId,
          runId,
          current: commitState.currentCheckpoint,
          plan,
          delivery,
        });

        const physical = await persistCoordinatorExecutionTransitions(client, {
          pendingFailures: commitState.pendingFailures,
          // Both independently proven exceptions already projected the logical
          // node; ordinary terminal writes must not rewrite physical success.
          rejectedForEachDeclarations: new Map([
            ...commitState.rejectedForEachDeclarations,
            ...commitState.stoppedForEachDeclarations,
          ]),
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
        await persistCoordinatorCallResult(client, preparedResult);
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
    return await observeCommittedCoordinatorSchedule(
      pool,
      transactionResult,
      input.signal,
    );
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

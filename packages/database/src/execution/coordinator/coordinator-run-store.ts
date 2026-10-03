import { acquireDatabasePool } from '../../platform/database-runtime.js';
import type { DatabaseRuntime } from '../../platform/database-runtime.js';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';

import type { DatabaseConfig } from '../../config.js';
import {
  CoordinatorDeliveryMismatchError,
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  type AcknowledgeAdvanceDeliveryInput,
  type AcknowledgeAdvanceDeliveryResult,
  type CommitAdvancePlanInput,
  type CommitAdvancePlanResult,
  type CoordinatorAdvanceDelivery,
  type CoordinatorRunStore,
  type LoadAdvanceStateInput,
  type LoadAdvanceStateResult,
} from './coordinator-run-store-contract.js';
import { commitCoordinatorAdvancePlan } from './coordinator-run-store-commit.js';
import { acknowledgeCoordinatorDelivery } from './coordinator-run-store-delivery.js';
import { loadCoordinatorAdvanceState } from './coordinator-run-store-observations.js';
import type { CoordinatorCallAdmissionOptions } from './coordinator-call-admission.js';

export {
  CoordinatorDeliveryMismatchError,
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
};
export type {
  AcknowledgeAdvanceDeliveryResult,
  CommitAdvancePlanResult,
  CoordinatorAdvanceDelivery,
  CoordinatorRunStore,
  LoadAdvanceStateResult,
};
export type CoordinatorRunStoreOptions = Readonly<{
  workflowCallAdmission?: CoordinatorCallAdmissionOptions;
  callableResultEvaluator?: ExpressionEvaluator;
  runTimeoutFailureContextEnabled?: boolean;
  /** ADR 055: record terminal failures for the workspace inbox. */
  workspaceInboxProducerEnabled?: boolean;
  /** ADR 056: record schedule and webhook run outcomes for failure streaks. */
  workflowTriggerOutcomesEnabled?: boolean;
}>;

export function createCoordinatorRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  options: CoordinatorRunStoreOptions = {},
): CoordinatorRunStore {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    acknowledgeAdvanceDelivery: (input: AcknowledgeAdvanceDeliveryInput) =>
      acknowledgeCoordinatorDelivery(pool, input),
    loadAdvanceState: (input: LoadAdvanceStateInput) =>
      loadCoordinatorAdvanceState(pool, input),
    commitAdvancePlan: (input: CommitAdvancePlanInput) =>
      commitCoordinatorAdvancePlan(pool, input, {
        runTimeoutFailureContextEnabled:
          options.runTimeoutFailureContextEnabled ?? false,
        workspaceInboxProducerEnabled:
          options.workspaceInboxProducerEnabled ?? false,
        workflowTriggerOutcomesEnabled:
          options.workflowTriggerOutcomesEnabled ?? false,
        ...(options.workflowCallAdmission === undefined
          ? {}
          : { workflowCallAdmission: options.workflowCallAdmission }),
        ...(options.callableResultEvaluator === undefined
          ? {}
          : { callableResultEvaluator: options.callableResultEvaluator }),
      }),
    close: () => lease.close(),
  });
}

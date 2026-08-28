import { createDatabasePool } from './postgres-telemetry.js';

import type { DatabaseConfig } from './config.js';
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
export function createCoordinatorRunStore(
  config: DatabaseConfig,
): CoordinatorRunStore {
  const pool = createDatabasePool(config);
  return Object.freeze({
    acknowledgeAdvanceDelivery: (input: AcknowledgeAdvanceDeliveryInput) =>
      acknowledgeCoordinatorDelivery(pool, input),
    loadAdvanceState: (input: LoadAdvanceStateInput) =>
      loadCoordinatorAdvanceState(pool, input),
    commitAdvancePlan: (input: CommitAdvancePlanInput) =>
      commitCoordinatorAdvancePlan(pool, input),
    close: async (): Promise<void> => pool.end(),
  });
}

import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

export function assertPlan(condition: boolean): asserts condition {
  if (!condition) throw new CoordinatorPlanInvalidError();
}

export function sameStoredValue(left: unknown, right: unknown): boolean {
  return (
    serializeStoredExecutionJsonValue(left) ===
    serializeStoredExecutionJsonValue(right)
  );
}

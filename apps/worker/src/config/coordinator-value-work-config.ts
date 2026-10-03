import { z } from 'zod';
import {
  COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
  type CoordinatorValueWorkPolicy,
} from '../execution/coordinator-value-work-lifetime.js';

const schema = z.object({
  controlPollMillis: z.coerce
    .number()
    .int()
    .min(100)
    .max(1_000)
    .default(COORDINATOR_VALUE_WORK_POLICY_DEFAULTS.controlPollMillis),
  controlReadTimeoutMillis: z.coerce
    .number()
    .int()
    .min(100)
    .max(5_000)
    .default(COORDINATOR_VALUE_WORK_POLICY_DEFAULTS.controlReadTimeoutMillis),
  operationTimeoutMillis: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(COORDINATOR_VALUE_WORK_POLICY_DEFAULTS.operationTimeoutMillis),
});

/** Accepted ADR065 policy; parsing grants no native execution capability. */
export function parseCoordinatorValueWorkPolicy(
  environment: Readonly<Record<string, string | undefined>>,
): CoordinatorValueWorkPolicy {
  return Object.freeze(
    schema.parse({
      controlPollMillis: environment.WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS,
      controlReadTimeoutMillis:
        environment.WORKFLOW_NATIVE_VALUE_CONTROL_READ_TIMEOUT_MILLIS,
      operationTimeoutMillis:
        environment.WORKFLOW_NATIVE_VALUE_OPERATION_TIMEOUT_MILLIS,
    }),
  );
}

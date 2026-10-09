import {
  CoordinatorRunStateCorruptError,
  CoordinatorDeliveryMismatchError,
} from '@pertexo/database/testing';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { createQueueConsumer } from '@pertexo/queue';

const engineCodes = new Set([
  'checkpoint_invalid',
  'checkpoint_unsupported',
  'graph_invalid',
  'executable_invalid',
  'observation_invalid',
  'attempt_invalid',
  'attempt_aborted',
  'workflow_identity_invalid',
  'transition_invalid',
  'join_invalid',
  'join_unsatisfied',
  'loop_limit_exceeded',
  'loop_state_invalid',
]);
export function curatedCoordinatorFailure(error: unknown) {
  if (error instanceof CoordinatorRunStateCorruptError)
    return {
      phase: 'coordinator-handler',
      errorClass: 'CoordinatorRunStateCorruptError',
      code: null,
    };
  if (error instanceof CoordinatorDeliveryMismatchError)
    return {
      phase: 'coordinator-handler',
      errorClass: 'CoordinatorDeliveryMismatchError',
      code: null,
    };
  if (error instanceof WorkflowEngineError)
    return {
      phase: 'coordinator-handler',
      errorClass: 'WorkflowEngineError',
      code: engineCodes.has(error.code) ? error.code : null,
    };
  return { phase: 'coordinator-handler', errorClass: 'unknown', code: null };
}

/** Wraps the actual consumer/handler; records bounded classes only and rethrows
 * the original error without changing delivery, retry or acknowledgement. */
export function curatedCoordinatorConsumerFactory(
  record: (value: ReturnType<typeof curatedCoordinatorFailure>) => void,
  factory: typeof createQueueConsumer = createQueueConsumer,
): typeof createQueueConsumer {
  let failures = 0;
  return (options) =>
    factory({
      ...options,
      handler: async (delivery, context) => {
        try {
          await options.handler(delivery, context);
        } catch (error: unknown) {
          if (failures++ < 32) record(curatedCoordinatorFailure(error));
          throw error;
        }
      },
    });
}

import { CORE_INLINE_DEFINITION_VERSION } from '@pertexo/workflow-model';
import {
  NodeExecutorFailure,
  type CoreNodeExecutorRegistration,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CoreStepRefusal } from './core-step.errors.js';

export function inlineCoreExecutor(
  registration: NodeExecutorRegistration,
  binding: Required<Pick<CoreNodeExecutorRegistration, 'executeInline'>>,
): CoreNodeExecutorRegistration {
  return Object.freeze({
    ...registration,
    executor: Object.freeze({
      ...registration.executor,
      version: CORE_INLINE_DEFINITION_VERSION,
    }),
    ...binding,
  });
}

export function attemptStepRefusal(error: unknown): unknown {
  return error instanceof CoreStepRefusal
    ? new NodeExecutorFailure({ ...error.failure, possiblyDispatched: false })
    : error;
}

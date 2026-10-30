import {
  NodeExecutionAbortedError,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_VALIDATE_EXECUTOR } from './definition.js';
import {
  CoreValidateExecutionAbortedError,
  evaluateCoreValidate,
} from './semantics.js';
import type { CoreValidateConfig, CoreValidateInput } from './validation.js';

export const coreValidateExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_VALIDATE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    try {
      return Promise.resolve(
        evaluateCoreValidate(
          invocation.config as CoreValidateConfig,
          invocation.input as CoreValidateInput,
          invocation.signal,
        ),
      );
    } catch (error) {
      if (error instanceof CoreValidateExecutionAbortedError)
        return Promise.reject(new NodeExecutionAbortedError());
      return Promise.reject(
        error instanceof Error ? error : new Error('Validate execution failed'),
      );
    }
  },
});

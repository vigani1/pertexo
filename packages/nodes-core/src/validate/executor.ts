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
import {
  CORE_VALIDATE_CONFIG_SCHEMA,
  CORE_VALIDATE_INPUT_SCHEMA,
} from './validation.js';

export const coreValidateExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_VALIDATE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    try {
      return Promise.resolve(
        evaluateCoreValidate(
          CORE_VALIDATE_CONFIG_SCHEMA.parse(invocation.config),
          CORE_VALIDATE_INPUT_SCHEMA.parse(invocation.input),
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

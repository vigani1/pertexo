import {
  NodeInputValidationError,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import {
  parseTaskPrefill,
  FormValuesInvalidError,
  type TaskContext,
  type InputRequestConfig,
} from '@pertexo/workflow-model';
import { CORE_REQUEST_INPUT_EXECUTOR } from './definition.js';
export const coreRequestInputExecutor: NodeExecutorRegistration = Object.freeze(
  {
    executor: CORE_REQUEST_INPUT_EXECUTOR,
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
      const input = invocation.input as TaskContext;
      try {
        const context: TaskContext = {
          ...input,
          ...(input.prefill === undefined
            ? {}
            : {
                prefill: parseTaskPrefill(
                  (invocation.config as InputRequestConfig).fields,
                  input.prefill,
                ),
              }),
        };
        return Promise.resolve({ pending: true, context });
      } catch (error) {
        if (error instanceof FormValuesInvalidError)
          throw new NodeInputValidationError(prefillProblem(error));
        throw error;
      }
    },
  },
);

function prefillProblem(error: FormValuesInvalidError): string {
  const [first] = error.fields;
  return first === undefined || first.name === ''
    ? error.message
    : `Prefilled ${first.name}: ${first.message}`;
}

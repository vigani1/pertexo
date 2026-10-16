import {
  NodeExecutionRuntimeRequiredError,
  NodeCodeFailure,
  type NodeExecutorRegistration,
  type NodeExecutionInvocation,
  type JsonValue,
} from '@pertexo/node-sdk/server';
import { CORE_CODE_EXECUTOR } from './definition.js';
import type { CoreCodeConfig } from './validation.js';
export const coreCodeExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_CODE_EXECUTOR,
  execute: async ({
    config,
    input,
    runtime,
    signal,
  }: NodeExecutionInvocation<unknown, unknown>) => {
    const code = runtime?.code;
    if (code === undefined) throw new NodeExecutionRuntimeRequiredError();
    const settings = config as CoreCodeConfig;
    const result = await code.execute({
      code: settings.code,
      ...(settings.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: settings.timeoutSeconds }),
      input: input as JsonValue,
      signal,
    });
    runtime?.observeCodeDiagnostics?.(result.diagnostics);
    if (result.kind === 'failed')
      throw new NodeCodeFailure(result.code, result.diagnostics);
    return result.output;
  },
});

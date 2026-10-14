import type {
  NodeExecutorRegistration,
  NodeExecutionInvocation,
} from '@pertexo/node-sdk/server';
import type { JsonValue } from '@pertexo/workflow-model';
import { CORE_CALL_EXECUTOR } from './definition.js';

/** Prepares input only. The coordinator owns durable acceptance and child output. */
export const coreCallExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_CALL_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve((invocation.input as { input: JsonValue }).input),
});

import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_SUMMARIZE_EXECUTOR } from './definition.js';
import type { CoreSummarizeConfig, CoreSummarizeInput } from './validation.js';
import { summarizeItems } from '../collections/summarize.js';
export const coreSummarizeExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SUMMARIZE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      summarizeItems(
        invocation.config as CoreSummarizeConfig,
        invocation.input as CoreSummarizeInput,
        invocation.signal,
      ),
    ),
});

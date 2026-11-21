import {
  inlineCoreExecutor,
  attemptStepRefusal,
} from '../../../catalog/inline-registration.js';
import { inlineSummarize } from './summarize-kernel.js';
import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_SUMMARIZE_EXECUTOR } from './summarize.definition.js';
import type {
  CoreSummarizeConfig,
  CoreSummarizeInput,
} from './summarize.schemas.js';
import { summarizeItems } from './semantics.js';
export const coreSummarizeExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SUMMARIZE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    try {
      return Promise.resolve(
        summarizeItems(
          invocation.config as CoreSummarizeConfig,
          invocation.input as CoreSummarizeInput,
          invocation.signal,
        ),
      );
    } catch (error) {
      throw attemptStepRefusal(error);
    }
  },
});

export const coreSummarizeInlineExecutor = inlineCoreExecutor(
  coreSummarizeExecutor,
  {
    executeInline: inlineSummarize,
  },
);

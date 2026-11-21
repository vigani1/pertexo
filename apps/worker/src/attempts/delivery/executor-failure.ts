import { isIntegrationExecutorSummaryCode } from '@pertexo/node-catalog/server';
import {
  WorkflowEngineError,
  type EngineErrorCode,
} from '@pertexo/workflow-engine/server';
import { SUMMARY_RESULT_FAILURE } from '@pertexo/nodes-core';
import { describeMappingFailure } from '../execution/mapping-diagnostic.js';
import {
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
} from '@pertexo/core/attempts';
import {
  describeNodeRefusal,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import {
  FILE_PAGES_ERROR_CODE,
  CALLBACK_ERROR_CODE,
} from '@pertexo/node-sdk/server';
import {
  FILE_INPUT_ERROR_CODE,
  RUN_VALUES_ERROR_CODE,
  type ModelUsage,
} from '@pertexo/node-sdk';
import {
  UTILITY_ERROR_CODE,
  FILE_CREATION_ERROR_CODE,
} from '@pertexo/nodes-core/server';
import { FILE_SCRATCH_ERROR_CODE } from '../artifacts/scratch/space.js';
import { FILE_TRANSFER_ERROR_CODE } from '../artifacts/scratch/progress.js';

const executorSummaryCodes = new Set<string>([
  ...Object.values(FILE_PAGES_ERROR_CODE),
  ...Object.values(CALLBACK_ERROR_CODE),
  ...Object.values(RUN_VALUES_ERROR_CODE),
  ...Object.values(UTILITY_ERROR_CODE),
  ...Object.values(FILE_CREATION_ERROR_CODE),
  ...Object.values(FILE_SCRATCH_ERROR_CODE),
  ...Object.values(FILE_TRANSFER_ERROR_CODE),
  FILE_INPUT_ERROR_CODE,
  SUMMARY_RESULT_FAILURE.code,
]);

/** Admit executor diagnostics before private failure text reaches persistence. */
export function executorFailureCompletion(
  error: NodeExecutorFailure,
): Extract<
  Parameters<NodeAttemptRunStore['complete']>[0]['outcome'],
  { status: 'executor_failure' }
> &
  Readonly<{ modelUsage?: ModelUsage }> {
  const { modelUsage } = error;
  const summary = describeMappingFailure(error) ?? error.shownSummary;
  const safeErrorCode = error.safeErrorCode ?? `execution.${error.errorKind}`;
  if (
    error.errorSummary !== undefined &&
    !executorSummaryCodes.has(safeErrorCode) &&
    !isIntegrationExecutorSummaryCode(safeErrorCode)
  )
    throw new NodeAttemptStateCorruptError();
  return {
    status: 'executor_failure',
    failureKind: error.kind,
    ...(modelUsage === undefined ? {} : { modelUsage }),
    ...(error.minimumRetryDelayMillis === undefined
      ? {}
      : { minimumRetryDelayMillis: error.minimumRetryDelayMillis }),
    errorKind: error.errorKind,
    possiblyDispatched: error.possiblyDispatched,
    safeErrorCode,
    ...(summary === undefined ? {} : { errorSummary: summary }),
  };
}

const STEP_REFUSAL_CODES: ReadonlySet<EngineErrorCode> = new Set([
  'attempt_invalid',
  'variable_missing',
  'expression_failed',
  'expression_limit_exceeded',
]);

export function nodeFailureCompletion(
  error: unknown,
): ReturnType<typeof executorFailureCompletion> | undefined {
  if (error instanceof NodeExecutorFailure)
    return executorFailureCompletion(error);
  if (
    error instanceof WorkflowEngineError &&
    STEP_REFUSAL_CODES.has(error.code)
  ) {
    const reason =
      describeMappingFailure(error) ?? describeNodeRefusal(error.cause);
    return {
      status: 'executor_failure',
      failureKind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      safeErrorCode: `execution.${error.code}`,
      ...(reason === undefined ? {} : { errorSummary: reason }),
    };
  }
  return undefined;
}

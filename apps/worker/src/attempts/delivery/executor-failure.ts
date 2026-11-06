import { describeMappingFailure } from '../execution/mapping-diagnostic.js';
import { HTTP_RESPONSE_FAILURES } from '@pertexo/integrations';
import {
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
} from '@pertexo/core/attempts';
import type { NodeExecutorFailure } from '@pertexo/node-sdk/server';

import {
  FILE_PAGES_ERROR_CODE,
  CALLBACK_ERROR_CODE,
} from '@pertexo/node-sdk/server';
import {
  FILE_INPUT_ERROR_CODE,
  RUN_VALUES_ERROR_CODE,
} from '@pertexo/node-sdk';
import {
  UTILITY_ERROR_CODE,
  FILE_CREATION_ERROR_CODE,
} from '@pertexo/nodes-core/server';
import {
  EMAIL_ATTACHMENT_ERROR_CODES,
  HTTP_PAGINATION_FAILURES,
  HTTP_OAUTH2_FAILURES,
} from '@pertexo/integrations/server';
import { FILE_SCRATCH_ERROR_CODE } from '../artifacts/scratch/space.js';
import { FILE_TRANSFER_ERROR_CODE } from '../artifacts/scratch/progress.js';

const executorSummaryCodes = new Set<string>([
  ...Object.values(FILE_PAGES_ERROR_CODE),
  ...Object.values(CALLBACK_ERROR_CODE),
  ...Object.values(RUN_VALUES_ERROR_CODE),
  ...Object.values(UTILITY_ERROR_CODE),
  ...Object.values(FILE_CREATION_ERROR_CODE),
  ...Object.values(EMAIL_ATTACHMENT_ERROR_CODES),
  ...Object.values(FILE_SCRATCH_ERROR_CODE),
  ...Object.values(FILE_TRANSFER_ERROR_CODE),
  ...Object.keys(HTTP_PAGINATION_FAILURES),
  ...Object.keys(HTTP_OAUTH2_FAILURES),
  ...Object.keys(HTTP_RESPONSE_FAILURES),
  FILE_INPUT_ERROR_CODE,
]);

/** Admit executor diagnostics before private failure text reaches persistence. */
export function executorFailureCompletion(
  error: NodeExecutorFailure,
): Parameters<NodeAttemptRunStore['complete']>[0]['outcome'] {
  const summary = describeMappingFailure(error) ?? error.shownSummary;
  const safeErrorCode = error.safeErrorCode ?? `execution.${error.errorKind}`;
  if (
    error.errorSummary !== undefined &&
    !executorSummaryCodes.has(safeErrorCode)
  )
    throw new NodeAttemptStateCorruptError();
  return {
    status: 'executor_failure',
    failureKind: error.kind,
    ...(error.minimumRetryDelayMillis === undefined
      ? {}
      : { minimumRetryDelayMillis: error.minimumRetryDelayMillis }),
    errorKind: error.errorKind,
    possiblyDispatched: error.possiblyDispatched,
    safeErrorCode,
    ...(summary === undefined ? {} : { errorSummary: summary }),
  };
}

import {
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
} from '@pertexo/database/attempts';
import type { NodeExecutorFailure } from '@pertexo/node-sdk/server';

const dataExecutorSummaryCodes = new Set([
  'utility.invalid_data',
  'utility.text_fields',
  'utility.result_text',
  'utility.result_too_large',
  'utility.too_many_items',
  'utility.xml_name',
  'utility.xml_data',
  'utility.xml_input',
  'utility.xml_root',
  'utility.xml_malformed',
  'utility.xml_dtd',
  'utility.xml_depth',
  'utility.xml_size',
  'utility.html_selector',
  'utility.html_depth',
  'utility.html_size',
  'utility.crypto_input',
  'utility.hmac_connection',
  'utility.hmac_unavailable',
  'file.create_data',
  'file.create_columns',
  'file.create_size',
  'file.create_storage',
  'email.too_many_attachments',
  'email.attachments_too_large',
]);

/** Admit executor diagnostics before private failure text reaches persistence. */
export function executorFailureCompletion(
  error: NodeExecutorFailure,
): Parameters<NodeAttemptRunStore['complete']>[0]['outcome'] {
  const safeErrorCode = error.safeErrorCode ?? `execution.${error.errorKind}`;
  if (
    error.errorSummary !== undefined &&
    !dataExecutorSummaryCodes.has(safeErrorCode) &&
    safeErrorCode !== 'execution.file_input' &&
    !safeErrorCode.startsWith('http.pagination_') &&
    safeErrorCode !== 'execution.attempt_invalid'
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
    ...(error.errorSummary === undefined
      ? {}
      : { errorSummary: error.errorSummary }),
  };
}

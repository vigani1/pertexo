import {
  FILE_PAGES_ERROR_CODE,
  CALLBACK_ERROR_CODE,
} from '@pertexo/node-sdk/server';
import { RUN_VALUES_ERROR_CODE } from '@pertexo/node-sdk';
import {
  UTILITY_ERROR_CODE,
  FILE_CREATION_ERROR_CODE,
} from '@pertexo/nodes-core/server';
import {
  EMAIL_ATTACHMENT_ERROR_CODES,
  HTTP_PAGINATION_FAILURES,
  HTTP_OAUTH2_FAILURES,
} from '@pertexo/integrations/server';
import { FILE_SCRATCH_ERROR_CODE } from '../../src/attempts/artifacts/scratch/space.js';
import { FILE_TRANSFER_ERROR_CODE } from '../../src/attempts/artifacts/scratch/progress.js';
import { describe, expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { NodeAttemptStateCorruptError } from '@pertexo/core/attempts';
import { executorFailureCompletion } from '../../src/attempts/delivery/executor-failure.js';

describe('executor diagnostic persistence boundary', () => {
  const outcome = {
    kind: 'failed',
    errorKind: 'configuration',
    possiblyDispatched: false,
  };
  it.each([
    'execution.provider',
    'utility.unreviewed',
    'file.create_unreviewed',
    'email.unreviewed',
    'http.pagination_unreviewed',
    'http.oauth2_unreviewed',
  ])('refuses an unapproved private summary for %s', (safeErrorCode) => {
    expect(() =>
      executorFailureCompletion(
        new NodeExecutorFailure({
          ...outcome,
          safeErrorCode,
          errorSummary: 'Unreviewed provider text',
        }),
      ),
    ).toThrow(NodeAttemptStateCorruptError);
    expect(
      executorFailureCompletion(
        new NodeExecutorFailure({ ...outcome, safeErrorCode }),
      ),
    ).toMatchObject({ safeErrorCode });
  });
  it.each([
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
    'file.create_size',
    'email.attachments_too_large',
    'email.too_many_attachments',
    'execution.file_input',
    'http.pagination_invalid_page',
  ])('admits a sanitized diagnostic for %s', (safeErrorCode) => {
    expect(
      executorFailureCompletion(
        new NodeExecutorFailure({
          ...outcome,
          safeErrorCode,
          errorSummary: 'Fixed safe diagnostic',
        }),
      ),
    ).toMatchObject({ errorSummary: 'Fixed safe diagnostic' });
  });
  it('keeps content-free fallback codes and retry timing', () => {
    expect(
      executorFailureCompletion(
        new NodeExecutorFailure({ ...outcome, minimumRetryDelayMillis: 25 }),
      ),
    ).toEqual({
      status: 'executor_failure',
      failureKind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      safeErrorCode: 'execution.configuration',
      minimumRetryDelayMillis: 25,
    });
  });
});

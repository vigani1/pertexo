import { describe, expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { NodeAttemptStateCorruptError } from '@pertexo/database/attempts';
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
    'utility.invalid_data',
    'file.create_size',
    'email.attachments_too_large',
    'email.too_many_attachments',
    'execution.file_input',
    'http.pagination_limit',
    'execution.attempt_invalid',
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

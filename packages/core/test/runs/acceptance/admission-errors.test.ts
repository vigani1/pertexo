import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../../../src/runs/commands/acceptance/run-admission.errors.js';
import { throwWorkflowRunAdmissionError } from '../../../src/runs/commands/acceptance/admission.repository.js';

function databaseError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(`database ${code}`, { cause }), { code });
}

function captureAdmissionError(error: unknown): unknown {
  try {
    throwWorkflowRunAdmissionError(error);
  } catch (caught: unknown) {
    return caught;
  }
}

describe('queued workflow-run admission error classification', () => {
  it.each([
    ['PTA01', WorkspaceRunAdmissionDeniedError],
    ['PTA02', WorkspaceRunQuotaExceededError],
  ] as const)(
    'maps direct and Drizzle-wrapped %s at this operation boundary',
    (code, ErrorType) => {
      expect(captureAdmissionError(databaseError(code))).toBeInstanceOf(
        ErrorType,
      );
      expect(
        captureAdmissionError(
          new DrizzleQueryError('insert', [], databaseError(code)),
        ),
      ).toBeInstanceOf(ErrorType);
    },
  );

  it('preserves unrelated and non-Error rejections exactly', () => {
    for (const rejection of [databaseError('23505'), undefined, null, 'failed'])
      expect(captureAdmissionError(rejection)).toBe(rejection);
  });

  it('terminates on cyclic causes and preserves the original rejection', () => {
    const original = new Error('cyclic');
    original.cause = original;
    expect(captureAdmissionError(original)).toBe(original);
  });
});

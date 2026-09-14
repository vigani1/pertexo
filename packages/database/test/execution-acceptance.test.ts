import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_STATUS,
  IDEMPOTENCY_STATUS_VALUES,
  RUN_STATUS,
  RUN_STATUS_VALUES,
  RegionalWriteAdmissionPausedError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
  throwWorkflowRunAdmissionError,
} from '../src/execution/execution-acceptance.js';

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

describe('execution vocabulary', () => {
  it('exports the authoritative workflow-run statuses', () => {
    expect(RUN_STATUS).toEqual({
      canceled: 'canceled',
      failed: 'failed',
      outcomeUnknown: 'outcome_unknown',
      queued: 'queued',
      running: 'running',
      succeeded: 'succeeded',
      timedOut: 'timed_out',
      waiting: 'waiting',
    });
    expect(RUN_STATUS_VALUES).toEqual([
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]);
  });

  it('exports the authoritative active idempotency statuses', () => {
    expect(IDEMPOTENCY_STATUS).toEqual({
      completed: 'completed',
      failed: 'failed',
      inProgress: 'in_progress',
    });
    expect(IDEMPOTENCY_STATUS_VALUES).toEqual([
      'in_progress',
      'completed',
      'failed',
    ]);
  });
});

describe('queued workflow-run admission error classification', () => {
  it.each([
    ['PTA01', WorkspaceRunAdmissionDeniedError],
    ['PTA02', WorkspaceRunQuotaExceededError],
    ['PTA03', RegionalWriteAdmissionPausedError],
  ] as const)(
    'maps direct and nested %s at this operation boundary',
    (code, ErrorType) => {
      expect(captureAdmissionError(databaseError(code))).toBeInstanceOf(
        ErrorType,
      );
      expect(
        captureAdmissionError(
          new Error('outer', { cause: databaseError(code) }),
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

  it('preserves errors when code or cause inspection throws', () => {
    for (const field of ['code', 'cause'] as const) {
      const original = Object.defineProperty(
        new Error(`hostile ${field}`),
        field,
        {
          get: () => {
            throw new Error(`secondary ${field}`);
          },
        },
      );
      expect(captureAdmissionError(original)).toBe(original);
    }
    const target = new Error('proxied');
    const proxied = new Proxy(target, {
      get: () => {
        throw new Error('proxy trap');
      },
    });
    expect(captureAdmissionError(proxied)).toBe(proxied);
  });
});

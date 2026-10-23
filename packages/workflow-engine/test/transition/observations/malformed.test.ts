import { describe, expect, it } from 'vitest';
import { advanceWorkflow, createCheckpoint } from '../../../src/index.js';

import { standardExecutable } from '../../support/transition/operations.js';

describe('node operation risk branches', () => {
  it.each([
    ['non-array window', { invalid: true }, 'observations must be an array'],
    [
      'numeric deadline timestamp',
      [{ kind: 'deadline_expired', occurredAt: 1 }],
      'deadline timestamp is invalid',
    ],
    [
      'overlong deadline timestamp',
      [{ kind: 'deadline_expired', occurredAt: 'x'.repeat(36) }],
      'deadline timestamp is invalid',
    ],
    [
      'malformed attempt failure',
      [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: 'not-a-uuid',
          attemptNumber: 0,
          failureKind: 'unknown',
          errorKind: 'unknown',
          possiblyDispatched: 'yes',
          safeErrorCode: '',
        },
      ],
      'attempt failure is invalid',
    ],
    [
      'invalid due invocation',
      [
        {
          kind: 'due_at',
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: '',
        },
      ],
      'due observation is invalid',
    ],
    [
      'invalid cursor event name',
      [
        {
          kind: 'cursor_only',
          eventName: 'node.unknown',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
        },
      ],
      'cursor event name is invalid',
    ],
    [
      'invalid cursor attempt',
      [
        {
          kind: 'cursor_only',
          eventName: 'node.progress',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: 'invalid',
          attemptNumber: 0,
        },
      ],
      'cursor event is invalid',
    ],
    [
      'invalid wait correlation',
      [
        {
          kind: 'wait',
          eventName: 'node.waiting',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          resumeAt: '2026-08-20T10:01:00.000Z',
          waitKind: 'node_wait',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000003',
          },
        },
      ],
      'wait observation is invalid',
    ],
    [
      'invalid outcome status',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'unknown',
        },
      ],
      'outcome observation is invalid',
    ],
    [
      'invalid outcome reason code',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'failed',
          reasonCode: '',
        },
      ],
      'reasonCode is invalid',
    ],
    [
      'mismatched inline outcome',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000003',
          },
        },
      ],
      'inline output must reference the completing attempt',
    ],
    [
      'invalid artifact outcome',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'artifact', artifactId: 'invalid' },
        },
      ],
      'artifact output is invalid',
    ],
    [
      'unsupported outcome output',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'unknown' },
        },
      ],
      'output reference kind is invalid',
    ],
    [
      'unsupported observation kind',
      [
        {
          kind: 'unknown',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      'observation kind is unsupported by the baseline engine',
    ],
  ] as const)(
    'rejects the public durable-observation boundary for %s',
    async (_label, observations, message) => {
      await expect(
        advanceWorkflow({
          runId: 'run-observation-boundary',
          executable: standardExecutable(),
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          checkpoint: createCheckpoint({
            workflowVersionId: '00000000-0000-4000-8000-000000000001',
            iterationBudget: 100,
          }),
          observations,
          occurredAt: '2026-08-20T10:00:00.000Z',
          maximumAdmissions: 0,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'observation_invalid', message });
    },
  );
  it('rejects one JSON-compatible fact above the per-fact canonical byte bound', async () => {
    await expect(
      advanceWorkflow({
        runId: 'run-observation-fact-size',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations: [
          {
            kind: 'cancel_requested',
            sequence: 2,
            occurredAt: '2026-08-20T10:00:00.000Z',
            padding: 'x'.repeat(4_096),
          } as never,
        ],
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'observation_invalid',
      message: 'observation fact is too large',
    });
  });
  it('admits a valid wait output before enforcing downstream correlation', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000002';
    await expect(
      advanceWorkflow({
        runId: 'run-valid-wait-output',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations: [
          {
            kind: 'wait',
            eventName: 'node.waiting',
            sequence: 2,
            occurredAt: '2026-08-20T10:00:00.000Z',
            invocationKey: 'missing-invocation',
            attemptId,
            attemptNumber: 1,
            resumeAt: '2026-08-20T10:01:00.000Z',
            waitKind: 'node_wait',
            output: { kind: 'inline', attemptId },
          },
        ],
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });
});

import { expect, it, vi } from 'vitest';
import { CoordinatorRunStateCorruptError } from '@pertexo/database/testing';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { JOB_NAME, QUEUE_NAME, type createQueueConsumer } from '@pertexo/queue';
import {
  curatedCoordinatorFailure,
  curatedCoordinatorConsumerFactory,
} from './coordinator-diagnostic.js';

it.each([
  new CoordinatorRunStateCorruptError(),
  new WorkflowEngineError('observation_invalid', 'private auth/config/output'),
  new Error('private auth/config/output'),
  {
    name: 'CoordinatorRunStateCorruptError',
    message: 'private',
    code: 'private',
  },
])(
  'projects fixed actual error classes without messages or spoofed names',
  (error) => {
    const encoded = JSON.stringify(curatedCoordinatorFailure(error));
    expect(encoded).not.toContain('private');
    expect(encoded).not.toContain('message');
  },
);

it('records at most 32 failures and preserves the actual rejected error', async () => {
  const record = vi.fn();
  let installed: Parameters<typeof createQueueConsumer>[0] | undefined;
  const consumer = {
    close: vi.fn(),
    isReady: () => true,
    waitUntilReady: vi.fn(),
  };
  const factory: typeof createQueueConsumer = (options) => {
    installed = options;
    return consumer;
  };
  const error = new WorkflowEngineError('observation_invalid', 'private');
  const wrapped = curatedCoordinatorConsumerFactory(record, factory);
  expect(
    wrapped({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://unused.invalid',
      handler: async () => {
        await Promise.resolve();
        throw error;
      },
    }),
  ).toBe(consumer);
  if (installed === undefined) throw new Error('Consumer was not installed');
  for (let index = 0; index < 33; index++) {
    await expect(
      installed.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            outboxEventId: '00000000-0000-4000-8000-000000000001',
            workspaceId: '00000000-0000-4000-8000-000000000002',
            runId: '00000000-0000-4000-8000-000000000003',
          },
          transport: { attemptsMade: 0, jobId: 'owned' },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBe(error);
  }
  expect(record).toHaveBeenCalledTimes(32);
  expect(record).toHaveBeenCalledWith({
    phase: 'coordinator-handler',
    errorClass: 'WorkflowEngineError',
    code: 'observation_invalid',
  });
});

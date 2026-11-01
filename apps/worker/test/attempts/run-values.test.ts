import { expect, it, vi } from 'vitest';
import {
  RunValuesLimitError,
  ExecutionCapabilityExpiredError,
  type RunValuesStore,
} from '@pertexo/core/runs';
import { createRunValuesRuntime } from '../../src/attempts/execution/run-values.js';
const context = {
  workspaceId: 'workspace',
  runId: 'run',
  nodeRunId: 'node-run',
  attemptId: 'attempt',
  attemptNumber: 1,
  nodeId: 'node',
  invocationKey: 'invocation',
  workerId: 'worker',
  fenceToken: 3,
};
it('binds values to the current execution and uses existing credential redaction before persistence', async () => {
  const save = vi
    .fn<RunValuesStore['save']>()
    .mockImplementation(({ values }) => Promise.resolve(values));
  const runtime = createRunValuesRuntime({ save }, context, () => undefined);
  const signal = new AbortController().signal;
  const values = await runtime.save({
    values: {
      orderId: 'A-1042',
      accessToken: 'opaque-secret',
      header: 'Bearer private-token',
    },
    signal,
  });
  expect(values.orderId).toBe('A-1042');
  expect(JSON.stringify(values)).not.toContain('opaque-secret');
  expect(JSON.stringify(values)).not.toContain('private-token');
  expect(save).toHaveBeenCalledWith({ ...context, values, signal });
});
it.each([
  [new RunValuesLimitError(), 'failed', 'run.values_limit'],
  [
    new ExecutionCapabilityExpiredError(),
    'failed',
    'run.values_attempt_expired',
  ],
  [new Error('private database detail'), 'retry', 'run.values_unavailable'],
])(
  'uses closed diagnostics without private database messages',
  async (error, kind, safeErrorCode) => {
    const save = vi.fn<RunValuesStore['save']>().mockRejectedValue(error);
    await expect(
      createRunValuesRuntime({ save }, context, () => undefined).save({
        values: { order: 'a' },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind, safeErrorCode, possiblyDispatched: false });
  },
);
it('does not reach the store after cancellation or closure', async () => {
  const save = vi.fn<RunValuesStore['save']>();
  const aborted = AbortSignal.abort();
  await expect(
    createRunValuesRuntime({ save }, context, () => undefined).save({
      values: { order: 'a' },
      signal: aborted,
    }),
  ).rejects.toBeDefined();
  await expect(
    createRunValuesRuntime({ save }, context, () => {
      throw new Error('closed');
    }).save({ values: { order: 'a' }, signal: new AbortController().signal }),
  ).rejects.toThrow('closed');
  expect(save).not.toHaveBeenCalled();
});

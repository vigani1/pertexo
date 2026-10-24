import { executionRuntime } from '../support/execution-runtime.js';
import { it, expect, vi } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
const scope = executionRuntime();
it('saves mapped business pairs through the execution capability and returns sanitized values', async () => {
  const save = vi
    .fn<NonNullable<NodeExecutionRuntime['runValues']>['save']>()
    .mockResolvedValue({ orderId: 'A-1042', accessToken: '[Redacted]' });
  const signal = new AbortController().signal;
  const result = await createCoreNodeRegistry().execute({
    definition: { key: 'core.run_values', version: 1 },
    executor: { key: 'core.run_values', version: 1 },
    config: {},
    input: { values: { orderId: 'A-1042', accessToken: 'private' } },
    signal,
    runtime: { ...scope, runValues: { save } },
  });
  expect(save).toHaveBeenCalledWith({
    values: { orderId: 'A-1042', accessToken: 'private' },
    signal,
  });
  expect(result).toEqual({
    kind: 'succeeded',
    output: { values: { orderId: 'A-1042', accessToken: '[Redacted]' } },
  });
});
it('refuses missing persistence without silently succeeding', async () => {
  await expect(
    createCoreNodeRegistry().execute({
      definition: { key: 'core.run_values', version: 1 },
      executor: { key: 'core.run_values', version: 1 },
      config: {},
      input: { values: { orderId: 'a' } },
      signal: new AbortController().signal,
      runtime: scope,
    }),
  ).rejects.toMatchObject({
    kind: 'failed',
    safeErrorCode: 'run.values_unavailable',
  });
});

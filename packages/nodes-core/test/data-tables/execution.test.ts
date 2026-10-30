import { executionRuntime } from '../support/execution-runtime.js';
import { it, expect, vi } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { DataTableError } from '@pertexo/node-sdk';
const scope = executionRuntime({ sideEffectClass: 'idempotent_with_key' });
it('passes mapped row values and filters to the scoped capability without embedding identities in portable config', async () => {
  const execute = vi
    .fn<NonNullable<NodeExecutionRuntime['dataTables']>['execute']>()
    .mockResolvedValue({ rows: [], affected: 1, hasMore: false });
  const registry = createCoreNodeRegistry();
  const signal = new AbortController().signal;
  expect(
    await registry.execute({
      definition: { key: 'core.table_insert', version: 1 },
      executor: { key: 'core.table_insert', version: 1 },
      config: { table: 'Orders' },
      input: { values: { key: 'a', amount: 2 } },
      signal,
      runtime: { ...scope, dataTables: { execute } },
    }),
  ).toEqual({
    kind: 'succeeded',
    output: { rows: [], affected: 1, hasMore: false },
  });
  expect(execute).toHaveBeenCalledWith({
    signal,
    command: {
      operation: 'insert',
      table: 'Orders',
      values: { key: 'a', amount: 2 },
    },
  });
});
it('turns missing tables and quota failures into closed safe configuration codes', async () => {
  const registry = createCoreNodeRegistry();
  const execute = vi
    .fn<NonNullable<NodeExecutionRuntime['dataTables']>['execute']>()
    .mockRejectedValue(
      new DataTableError(
        'quota_exceeded',
        'Private value must not leave the store',
      ),
    );
  await expect(
    registry.execute({
      definition: { key: 'core.table_insert', version: 1 },
      executor: { key: 'core.table_insert', version: 1 },
      config: { table: 'Orders' },
      input: { values: { key: 'a' } },
      signal: new AbortController().signal,
      runtime: { ...scope, dataTables: { execute } },
    }),
  ).rejects.toMatchObject({
    code: 'quota_exceeded',
    errorKind: 'configuration',
    kind: 'failed',
  });
});
// nodes-15: a step run without the data-table capability is reported as
// "table not found", blaming the user's table for a platform wiring gap.
it.fails(
  'reports a missing data-table capability as an internal failure, not a missing table',
  async () => {
    await expect(
      createCoreNodeRegistry().execute({
        definition: { key: 'core.table_insert', version: 1 },
        executor: { key: 'core.table_insert', version: 1 },
        config: { table: 'Orders' },
        input: { values: { key: 'a' } },
        signal: new AbortController().signal,
        runtime: scope,
      }),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'internal',
      possiblyDispatched: false,
    });
  },
);

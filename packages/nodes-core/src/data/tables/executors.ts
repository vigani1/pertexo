import {
  DataTableError,
  type DataTableConfig,
  type DataTableCommand,
} from '@pertexo/node-sdk';
import {
  NodeExecutorFailure,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { NodeDataTableFailure } from '@pertexo/node-sdk/server';
import { DATA_TABLE_OPERATIONS } from './definitions.js';
export const DATA_TABLE_EXECUTORS: readonly NodeExecutorRegistration[] =
  DATA_TABLE_OPERATIONS.map((operation) => ({
    executor: { key: `core.table_${operation}`, version: 1 },
    execute: async (invocation) => {
      const runtime = invocation.runtime?.dataTables;
      // A wiring gap of ours, not a table the user got wrong.
      if (runtime === undefined)
        throw new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'internal',
          possiblyDispatched: false,
        });
      const { table, columnBindings } = invocation.config as DataTableConfig;
      const command = {
        ...(invocation.input as object),
        operation,
        table,
      } as DataTableCommand;
      try {
        if (operation !== 'find') await invocation.runtime?.beforeDispatch();
        return await runtime.execute({
          command,
          ...(columnBindings === undefined ? {} : { columnBindings }),
          signal: invocation.signal,
        });
      } catch (error) {
        if (error instanceof NodeExecutorFailure) throw error;
        if (error instanceof DataTableError)
          throw new NodeDataTableFailure(error.code);
        if (invocation.signal.aborted)
          throw new NodeExecutorFailure({
            kind: 'canceled',
            errorKind: 'canceled',
            possiblyDispatched: operation !== 'find',
          });
        throw new NodeExecutorFailure({
          kind: 'retry',
          errorKind: 'internal',
          possiblyDispatched: operation !== 'find',
        });
      }
    },
  }));

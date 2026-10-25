import {
  bindDataTableCommand,
  DataTableError,
  dataTableResultSchema,
  projectBoundDataTableResult,
  resolveDataTableBindings,
} from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import {
  assertCapabilityExecution,
  lockCapabilityExecution,
} from '../attempts/dispatch/fence.repository.js';
import { ExecutionCapabilityExpiredError } from '../attempts/errors.js';
import { withWorkspaceWriteClient } from '../attempts/transactions.repository.js';
import type { DatabaseConfig } from '../config.js';
import { appendAuditFact } from '../governance/audit/events.repository.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/pool/runtime.js';
import { rethrowQueryFailure } from '../platform/query-errors.js';
import { dataTableWriteReceipts as receipts } from '../schema/data-tables.js';
import type { WorkerDataTablesStore } from './contract.js';
import { readQuotas, requireTable } from './definitions.queries.js';
import { findRows } from './rows.queries.js';
import { mutateRows, translateTableConstraint } from './rows.repository.js';
export function createWorkerDataTablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkerDataTablesStore {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    execute: (input) =>
      withWorkspaceWriteClient(
        lease.pool,
        input.workspaceId,
        input.signal,
        async (client) => {
          await lockCapabilityExecution(client, input);
          if (input.command.operation === 'find') {
            await assertCapabilityExecution(client, input);
            const table = await requireTable(client, input.workspaceId, {
              name: input.command.table,
            });
            const names = resolveDataTableBindings({
              columns: table.columns,
              bindings: input.columnBindings,
              hasRemovedColumns: table.hasRemovedColumns,
            });
            const command = bindDataTableCommand(input.command, names);
            if (command.operation !== 'find')
              throw new Error('Read operation changed');
            return projectBoundDataTableResult(
              await findRows(client, input.workspaceId, table, command.query),
              names,
            );
          }
          const quotas = await readQuotas(client, input.workspaceId, {
            lock: true,
          });
          await assertCapabilityExecution(client, input, {
            requireDispatch: true,
          });
          const requestHash = tableRequestHash(input);
          const db = drizzle(client);
          const [prior] = await db
            .select({
              requestHash: receipts.requestHash,
              resultJson: receipts.result,
            })
            .from(receipts)
            .where(
              and(
                eq(receipts.workspaceId, input.workspaceId),
                eq(receipts.executionId, input.runId),
                eq(receipts.invocationId, input.nodeRunId),
              ),
            )
            .catch(rethrowQueryFailure);
          if (prior !== undefined) {
            if (prior.requestHash !== requestHash)
              throw new DataTableError(
                'conflict',
                'The retried data table command changed.',
              );
            return dataTableResultSchema.parse(JSON.parse(prior.resultJson));
          }
          const table = await requireTable(
            client,
            input.workspaceId,
            { name: input.command.table },
            { lock: true },
          );
          const names = resolveDataTableBindings({
            columns: table.columns,
            bindings: input.columnBindings,
            hasRemovedColumns: table.hasRemovedColumns,
          });
          const command = bindDataTableCommand(input.command, names);
          if (command.operation === 'find')
            throw new Error('Write operation changed');
          const result = projectBoundDataTableResult(
            await mutateRows(client, input.workspaceId, {
              table,
              quotas,
              command,
            }),
            names,
          );
          await assertCapabilityExecution(client, input, {
            requireDispatch: true,
          });
          await db
            .insert(receipts)
            .values({
              workspaceId: input.workspaceId,
              executionId: input.runId,
              invocationId: input.nodeRunId,
              runId: input.previewRunId === undefined ? input.runId : null,
              previewRunId: input.previewRunId ?? null,
              requestHash,
              result: JSON.stringify(result),
            })
            .catch(rethrowQueryFailure);
          await appendAuditFact(client, {
            workspaceId: input.workspaceId,
            action: 'data.tables.rows.write',
            targetType: 'data_table',
            targetId: table.id,
            metadata: {
              actorKind: 'workflow',
              runId: input.runId,
              invocationId: input.nodeRunId,
              operation: command.operation,
              affected: result.affected,
            },
          });
          return result;
        },
      ).catch((error: unknown) => {
        if (error instanceof ExecutionCapabilityExpiredError)
          throw new DataTableError('attempt_expired', error.message);
        const transientStorageFailure =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string' &&
          (/^(?:08|40)/u.test(error.code) ||
            [
              '53300',
              '57P01',
              '57P02',
              '57P03',
              'ECONNRESET',
              'ECONNREFUSED',
              'ETIMEDOUT',
              'EPIPE',
            ].includes(error.code));
        if (transientStorageFailure)
          throw new DataTableError(
            'unavailable',
            'Data table storage is temporarily unavailable. The same write can be retried safely.',
          );
        return translateTableConstraint(error);
      }),
  };
}

function tableRequestHash(
  input: Parameters<WorkerDataTablesStore['execute']>[0],
): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        input.columnBindings === undefined
          ? input.command
          : {
              command: input.command,
              columnBindings: input.columnBindings,
            },
      ),
    )
    .digest('hex');
}

import { appendAuditFact } from '../governance/audit/append.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';
import {
  DataTableError,
  resolveDataTableBindings,
  bindDataTableCommand,
  projectBoundDataTableResult,
  type DataTableResult,
} from '@pertexo/node-sdk';
import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/pool/runtime.js';
import { withWorkspaceWriteClient } from '../attempts/transactions.js';
import type { WorkerDataTablesStore } from './contract.js';
import { readQuotas, requireTable } from './read.js';
import { findRows } from './queries.js';
import { mutateRows, translateTableConstraint } from './mutate.js';
import {
  lockCapabilityExecution,
  assertCapabilityExecution,
  ExecutionCapabilityExpiredError,
} from '../attempts/dispatch/fence.js';
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
          const quotas = await readQuotas(client, input.workspaceId, true);
          await assertCapabilityExecution(client, input, true);
          const requestHash = createHash('sha256')
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
          const prior = (
            await client.query<{ request_hash: string; result_json: string }>(
              'select request_hash,result_json from app.data_table_write_receipts where workspace_id=$1 and execution_id=$2 and invocation_id=$3',
              [input.workspaceId, input.runId, input.nodeRunId],
            )
          ).rows[0];
          if (prior !== undefined) {
            if (prior.request_hash !== requestHash)
              throw new DataTableError(
                'conflict',
                'The retried data table command changed.',
              );
            return JSON.parse(prior.result_json) as DataTableResult;
          }
          const table = await requireTable(
            client,
            input.workspaceId,
            { name: input.command.table },
            true,
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
            await mutateRows(client, input.workspaceId, table, quotas, command),
            names,
          );
          await assertCapabilityExecution(client, input, true);
          await client.query(
            'insert into app.data_table_write_receipts(workspace_id,execution_id,invocation_id,run_id,preview_run_id,request_hash,result_json) values($1,$2,$3,$4,$5,$6,$7)',
            [
              input.workspaceId,
              input.runId,
              input.nodeRunId,
              input.previewRunId === undefined ? input.runId : null,
              input.previewRunId ?? null,
              requestHash,
              JSON.stringify(result),
            ],
          );
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
        if (
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
            ].includes(error.code))
        )
          throw new DataTableError(
            'unavailable',
            'Data table storage is temporarily unavailable. The same write can be retried safely.',
          );
        return translateTableConstraint(error);
      }),
  };
}

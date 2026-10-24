import { RUN_VALUE_LIMITS, type RunValues } from '@pertexo/node-sdk';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { withWorkspaceWriteClient } from '../../attempts/transactions.repository.js';
import {
  lockCapabilityExecution,
  assertCapabilityExecution,
} from '../../attempts/dispatch/fence.repository.js';
import { RunValuesLimitError, type RunValuesStore } from './records.js';

export function createRunValuesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): RunValuesStore {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    save: (input) =>
      withWorkspaceWriteClient(
        lease.pool,
        input.workspaceId,
        input.signal,
        async (client): Promise<RunValues> => {
          await lockCapabilityExecution(client, input);
          await assertCapabilityExecution(client, input);
          const ownerColumn =
            input.previewRunId === undefined
              ? 'workflow_run_id'
              : 'preview_run_id';
          const ownerId = input.previewRunId ?? input.runId;
          const existing = await client.query<{ key: string; value: string }>(
            `select key,value from app.workflow_run_values where workspace_id=$1 and ${ownerColumn}=$2 order by key limit ${String(RUN_VALUE_LIMITS.pairs + 1)}`,
            [input.workspaceId, ownerId],
          );
          const values = new Map(
            existing.rows.map((row) => [row.key, row.value]),
          );
          const pairs = Object.entries(input.values);
          for (const [key, value] of pairs) values.set(key, value);
          if (values.size > RUN_VALUE_LIMITS.pairs)
            throw new RunValuesLimitError();
          if (pairs.length > 0) {
            const parameters: (string | null)[] = [];
            const rows = pairs.map(([key, value]) => {
              const first = parameters.length;
              parameters.push(
                generatePersistedId(),
                input.workspaceId,
                input.previewRunId === undefined ? input.runId : null,
                input.previewRunId ?? null,
                key,
                value,
              );
              return (
                '(' +
                Array.from(
                  { length: 6 },
                  (_, index) => '$' + String(first + index + 1),
                ).join(',') +
                ')'
              );
            });
            await client.query(
              `insert into app.workflow_run_values(id,workspace_id,workflow_run_id,preview_run_id,key,value) values ${rows.join(',')} on conflict(workspace_id,${ownerColumn},key) do update set value=excluded.value,updated_at=clock_timestamp()`,
              parameters,
            );
          }
          await assertCapabilityExecution(client, input);
          return Object.freeze(Object.fromEntries(values));
        },
      ),
  };
}

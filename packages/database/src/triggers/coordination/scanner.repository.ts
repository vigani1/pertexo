import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import {
  withPlatformTransaction,
  withWorkspaceTransaction,
} from '../../tenant-access/transactions.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../config.js';
import { releaseCoordinatedEvent } from './release.repository.js';
export interface TriggerEventScanner {
  scanDue(
    input: Readonly<{
      limit: number;
      checkpointFactory: InitialCheckpointFactory;
      signal?: AbortSignal;
    }>,
  ): Promise<
    Readonly<{
      examined: number;
      started: number;
      pending: number;
      refused: number;
      idle: number;
    }>
  >;
  close(): Promise<void>;
}
export function createTriggerEventScanner(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): TriggerEventScanner {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    async scanDue(input) {
      const due = await withPlatformTransaction(
        lease.pool,
        (client) =>
          client.query<{ workspace_id: string; event_id: string }>(
            'select * from app.discover_due_coordinated_events($1)',
            [input.limit],
          ),
        input.signal === undefined ? {} : { signal: input.signal },
      );
      const result = {
        examined: due.rows.length,
        started: 0,
        pending: 0,
        refused: 0,
        idle: 0,
      };
      const failures: unknown[] = [];
      for (const row of due.rows) {
        input.signal?.throwIfAborted();
        try {
          const outcome = await withWorkspaceTransaction(
            lease.pool,
            row.workspace_id,
            (transaction) =>
              releaseCoordinatedEvent(
                transaction,
                row.event_id,
                input.checkpointFactory,
              ),
            input.signal === undefined ? {} : { signal: input.signal },
          );
          result[outcome]++;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, 'Coordinated event scan failed');
      return result;
    },
  };
}

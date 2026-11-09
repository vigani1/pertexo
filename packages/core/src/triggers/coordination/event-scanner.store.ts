import type { ScanDueEventsInput } from './event-coordination.types.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withWorkspaceTransaction,
} from '@pertexo/database/primitives';

import {
  withPlatformTransaction,
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  releaseCoordinatedEvent,
  restFailedCoordinatedEvent,
} from './release.repository.js';

export type TriggerEventScanner = ReturnType<typeof createTriggerEventScanner>;

/** The worker releasing held events: no member behind it, so it stays off the helper. */
export function createTriggerEventScanner(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  maintenanceConfig?: DatabaseConfig,
) {
  const lease = acquireDatabasePool(config, runtime);
  const maintenance =
    maintenanceConfig === undefined
      ? undefined
      : acquireDatabasePool(maintenanceConfig, undefined, {
          role: 'maintenance',
        });
  return {
    close: async () => {
      await lease.close();
      await maintenance?.close();
    },
    async scanDue(input: ScanDueEventsInput) {
      const due = await withPlatformTransaction(
        maintenance?.pool ?? lease.pool,
        (client) =>
          drizzle(client)
            .execute<{ workspace_id: string; event_id: string }>(
              sql`select * from app.discover_due_coordinated_events(${input.limit})`,
            )
            .catch(rethrowQueryFailure),
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
          if (!input.signal?.aborted) {
            try {
              await withWorkspaceTransaction(
                lease.pool,
                row.workspace_id,
                (transaction) =>
                  restFailedCoordinatedEvent(transaction, row.event_id),
                { signal: AbortSignal.timeout(5_000) },
              );
            } catch (retirementError) {
              failures.push(retirementError);
            }
          }
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, 'Coordinated event scan failed');
      return result;
    },
  };
}

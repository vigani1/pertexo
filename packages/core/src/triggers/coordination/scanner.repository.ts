import type { TriggerEventScanner } from './contract.js';
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
import { releaseCoordinatedEvent } from './release.repository.js';
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
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, 'Coordinated event scan failed');
      return result;
    },
  };
}

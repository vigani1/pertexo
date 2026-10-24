import type { PoolClient } from 'pg';
import type { AuditFilter } from '@pertexo/contracts';
import { escapeCsvValue } from '@pertexo/node-sdk';
import { GovernanceError } from '../contract.js';
import {
  countAuditExport,
  readAuditBatch,
  projectAuditEvent,
  type AuditCursor,
} from './events.queries.js';
type Read = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
export async function prepareAuditExport(
  read: Read,
  workspaceId: string,
  query: AuditFilter,
  signal?: AbortSignal,
) {
  const count = await read(async (client) => {
    const count = await countAuditExport(client, workspaceId, query);
    if (count > 100_000)
      throw new GovernanceError(
        'invalid',
        'This export exceeds 100,000 events. Choose a narrower date range.',
      );
    const first = (
      await readAuditBatch(client, workspaceId, { query, limit: 1 })
    )[0];
    return {
      count,
      upper:
        first === undefined
          ? undefined
          : { time: first.cursorTime, id: first.id },
    };
  });
  async function* csv(): AsyncGenerator<string> {
    yield 'Time,Person,Person ID,Action,Target type,Target ID,Metadata\r\n';
    if (count.upper === undefined) return;
    let after: AuditCursor | undefined;
    let rows = 0;
    for (;;) {
      signal?.throwIfAborted();
      const batch = await read((client) =>
        readAuditBatch(client, workspaceId, {
          query,
          limit: 256,
          after,
          upper: count.upper,
        }),
      );
      if (batch.length === 0) return;
      for (const row of batch) {
        signal?.throwIfAborted();
        rows += 1;
        if (rows > 100_000)
          throw new GovernanceError(
            'invalid',
            'The audit log changed beyond the export bound. Choose a narrower date range.',
          );
        const event = projectAuditEvent(row);
        yield [
          event.occurredAt,
          event.actorName ?? 'System',
          event.actorId,
          event.action,
          event.targetType,
          event.targetId,
          JSON.stringify(event.metadata),
        ]
          .map(escapeCsvValue)
          .join(',') + '\r\n';
        after = { time: row.cursorTime, id: row.id };
      }
    }
  }
  return {
    csv: csv(),
    metadata: { filename: 'audit-log.csv', storedBytes: count.count * 8192 },
  };
}

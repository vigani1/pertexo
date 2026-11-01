import type { AuditFilter } from '@pertexo/contracts';
import { escapeCsvValue } from '@pertexo/node-sdk';
import type { PoolClient } from 'pg';

import { GovernanceError } from '../contract.js';
import { auditCursorOf, type AuditCursor } from './cursor.js';
import {
  countAuditEvents,
  readAuditBatch,
  type AuditRow,
} from './events.queries.js';
import { projectAuditEvent } from './page.js';

const MAX_EXPORTED_EVENTS = 100_000;
const BATCH_ROWS = 256;
/** A generous size per event, which sets how long the export may take. */
const BUDGETED_BYTES_PER_EVENT = 8192;
const HEADER =
  'Time,Person,Person ID,Action,Target type,Target ID,Metadata\r\n';

/** Every batch opens its own read, so authority is checked again as it runs. */
type Read = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

type AuditExport = Readonly<{
  workspaceId: string;
  query: AuditFilter;
  signal?: AbortSignal;
}>;

export async function streamAuditExport(read: Read, input: AuditExport) {
  const { events, upper } = await read((client) => measure(client, input));
  return {
    csv: csv(read, input, upper),
    metadata: {
      filename: 'audit-log.csv',
      storedBytes: events * BUDGETED_BYTES_PER_EVENT,
    },
  };
}

/** Refuses an oversized export up front and pins where it ends, so events added while it runs stay out. */
async function measure(
  client: PoolClient,
  { workspaceId, query }: AuditExport,
) {
  const events = await countAuditEvents(
    client,
    workspaceId,
    query,
    MAX_EXPORTED_EVENTS + 1,
  );
  if (events > MAX_EXPORTED_EVENTS)
    throw new GovernanceError(
      'invalid',
      'This export exceeds 100,000 events. Choose a narrower date range.',
    );
  const [newest] = await readAuditBatch(client, workspaceId, {
    query,
    limit: 1,
  });
  return {
    events,
    upper: newest === undefined ? undefined : auditCursorOf(newest),
  };
}

async function* csv(
  read: Read,
  { workspaceId, query, signal }: AuditExport,
  upper: AuditCursor | undefined,
): AsyncGenerator<string> {
  yield HEADER;
  if (upper === undefined) return;
  let after: AuditCursor | undefined;
  let rows = 0;
  for (;;) {
    signal?.throwIfAborted();
    const position = after;
    const batch = await read((client) =>
      readAuditBatch(client, workspaceId, {
        query,
        limit: BATCH_ROWS,
        after: position,
        upper,
      }),
    );
    if (batch.length === 0) return;
    for (const row of batch) {
      signal?.throwIfAborted();
      rows += 1;
      if (rows > MAX_EXPORTED_EVENTS)
        throw new GovernanceError(
          'invalid',
          'The audit log changed beyond the export bound. Choose a narrower date range.',
        );
      yield csvLine(row);
      after = auditCursorOf(row);
    }
  }
}

function csvLine(row: AuditRow): string {
  const event = projectAuditEvent(row);
  return (
    [
      event.occurredAt,
      event.actorName ?? 'System',
      event.actorId,
      event.action,
      event.targetType,
      event.targetId,
      JSON.stringify(event.metadata),
    ]
      .map(escapeCsvValue)
      .join(',') + '\r\n'
  );
}

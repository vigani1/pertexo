import type { AuditEvent, AuditPage, AuditQuery } from '@pertexo/contracts';
import { projectAuditMetadata } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import {
  auditCursorOf,
  encodeAuditCursor,
  type AuditCursor,
} from './cursor.js';
import { readAuditBatch, type AuditRow } from './events.queries.js';

export async function readAuditPage(
  client: PoolClient,
  { workspaceId, query }: Readonly<{ workspaceId: string; query: AuditQuery }>,
  after: AuditCursor | undefined,
): Promise<AuditPage> {
  // One row past the page says whether there's a next one.
  const rows = await readAuditBatch(client, workspaceId, {
    query,
    limit: query.limit + 1,
    after,
  });
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map(projectAuditEvent),
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeAuditCursor(auditCursorOf(last))
        : null,
  };
}

export function projectAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    occurredAt: row.occurredAt.toISOString(),
    metadata: projectAuditMetadata(row.metadata),
  };
}

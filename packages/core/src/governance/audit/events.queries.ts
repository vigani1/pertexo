import {
  rethrowQueryFailure,
  projectAuditMetadata,
} from '@pertexo/database/primitives';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  and,
  eq,
  exists,
  gte,
  lt,
  sql,
  count,
  desc,
  type SQL,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { auditEvents, users } from '@pertexo/database/schema';
import type { AuditFilter, AuditEvent } from '@pertexo/contracts';
import { GovernanceError } from '../contract.js';
const cursorSchema = z
  .object({ time: z.iso.datetime(), id: z.uuid() })
  .strict();
export type AuditCursor = z.output<typeof cursorSchema>;
export function decodeAuditCursor(
  encoded: string | undefined,
): AuditCursor | undefined {
  if (encoded === undefined) return undefined;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
  } catch {
    throw new GovernanceError(
      'invalid',
      'The audit cursor is invalid. Reload the audit log.',
    );
  }
}
export type AuditRow = Awaited<ReturnType<typeof readAuditBatch>>[number];
export function encodeAuditCursor(row: AuditRow): string {
  return Buffer.from(
    JSON.stringify({ time: row.cursorTime, id: row.id }),
  ).toString('base64url');
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
function auditWhere(
  client: PoolClient,
  workspaceId: string,
  query: AuditFilter,
  cursors: Readonly<{
    after?: AuditCursor | undefined;
    upper?: AuditCursor | undefined;
  }> = {},
) {
  const person = alias(users, 'person');
  return and(
    eq(auditEvents.workspaceId, workspaceId),
    query.person === undefined
      ? undefined
      : exists(
          drizzle(client)
            .select({ id: person.id })
            .from(person)
            .where(
              and(
                eq(person.id, auditEvents.actorUserId),
                sql`strpos(lower(${person.displayName}),lower(${query.person}))>0`,
              ),
            ),
        ),
    query.actorId === undefined
      ? undefined
      : eq(auditEvents.actorUserId, query.actorId),
    query.action === undefined
      ? undefined
      : eq(auditEvents.action, query.action),
    query.targetType === undefined
      ? undefined
      : eq(auditEvents.targetType, query.targetType),
    query.targetId === undefined
      ? undefined
      : eq(auditEvents.targetId, query.targetId),
    query.from === undefined
      ? undefined
      : gte(auditEvents.occurredAt, sql`${query.from}::timestamptz`),
    query.until === undefined
      ? undefined
      : lt(auditEvents.occurredAt, sql`${query.until}::timestamptz`),
    auditCursorPredicate(cursors.after, 'after'),
    auditCursorPredicate(cursors.upper, 'upper'),
  );
}

function auditCursorPredicate(
  cursor: AuditCursor | undefined,
  position: 'after' | 'upper',
): SQL | undefined {
  if (cursor === undefined) return undefined;
  // Keep PostgreSQL's microseconds: a JavaScript Date would truncate cursor time.
  if (position === 'after')
    return sql`(${auditEvents.occurredAt},${auditEvents.id}) < (${cursor.time}::timestamptz,${cursor.id}::uuid)`;
  return sql`(${auditEvents.occurredAt},${auditEvents.id}) <= (${cursor.time}::timestamptz,${cursor.id}::uuid)`;
}

export async function readAuditBatch(
  client: PoolClient,
  workspaceId: string,
  options: Readonly<{
    query: AuditFilter;
    limit: number;
    after?: AuditCursor | undefined;
    upper?: AuditCursor | undefined;
  }>,
) {
  const actor = alias(users, 'actor');
  return drizzle(client)
    .select({
      id: auditEvents.id,
      actorId: auditEvents.actorUserId,
      actorName: actor.displayName,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      occurredAt: auditEvents.occurredAt,
      cursorTime: sql<string>`to_char(${auditEvents.occurredAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .leftJoin(actor, eq(actor.id, auditEvents.actorUserId))
    .where(auditWhere(client, workspaceId, options.query, options))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(options.limit)
    .catch(rethrowQueryFailure);
}

export async function countAuditExport(
  client: PoolClient,
  workspaceId: string,
  query: AuditFilter,
): Promise<number> {
  const db = drizzle(client);
  const bounded = db.$with('bounded').as(
    db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(auditWhere(client, workspaceId, query))
      .limit(100_001),
  );
  const [result] = await db
    .with(bounded)
    .select({ count: count() })
    .from(bounded)
    .catch(rethrowQueryFailure);
  return result?.count ?? 0;
}

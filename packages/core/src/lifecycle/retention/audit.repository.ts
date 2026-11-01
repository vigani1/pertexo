import {
  auditEvents,
  connectionEvents,
  workspaces,
} from '@pertexo/database/schema';
import { AUDIT_RETENTION_MIN_DAYS } from '@pertexo/workflow-model';
import { and, asc, eq, getTableName, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { deletionRule } from './rows.repository.js';

export const auditHistory = {
  name: 'audit_events',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .innerJoin(workspaces, eq(workspaces.id, auditEvents.workspaceId))
        .where(
          and(
            sql`${auditEvents.occurredAt}<=statement_timestamp()-${AUDIT_RETENTION_MIN_DAYS}*interval '1 day'`,
            sql`${auditEvents.occurredAt}<=statement_timestamp()-${workspaces.auditRetentionDays}*interval '1 day'`,
          ),
        )
        .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id))
        .limit(pageSize)
        .for('update', {
          of: alias(auditEvents, getTableName(auditEvents)),
          skipLocked: true,
        }),
    );
    return (
      await db
        .with(page)
        .delete(auditEvents)
        .where(inArray(auditEvents.id, db.select({ id: page.id }).from(page)))
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;

// Every credential use writes one of these, so without a rule they grow for as
// long as the workspace lives. They follow the workspace's audit setting. Nothing
// updates them, so unlike the audit rule this needs no lock to skip.
export const connectionHistory = deletionRule('connection_events', {
  table: connectionEvents,
  keys: [connectionEvents.id],
  condition: and(
    sql`${connectionEvents.createdAt}<=statement_timestamp()-${AUDIT_RETENTION_MIN_DAYS}*interval '1 day'`,
    sql`${connectionEvents.createdAt}<=statement_timestamp()-(select ${workspaces.auditRetentionDays} from ${workspaces} where ${workspaces.id}=${connectionEvents.workspaceId})*interval '1 day'`,
  ),
  orderBy: [connectionEvents.createdAt, connectionEvents.id],
});

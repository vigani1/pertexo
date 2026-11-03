import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  noticePreferences,
  noticeWorkspaceSettings,
  workspaceMemberships as membershipsTable,
  workspaces,
} from '@pertexo/database/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import type { NoticeMailPerson } from './contract.js';

const workspaceMemberships = alias(membershipsTable, 'member');

/** Who is due, across workspaces, after `after` in a stable order. */
export function readMailCandidates(
  maintenance: Pool,
  after: NoticeMailPerson | undefined,
  limit: number,
): Promise<readonly NoticeMailPerson[]> {
  return drizzle(maintenance)
    .select({
      workspace_id: workspaceMemberships.workspaceId,
      user_id: workspaceMemberships.userId,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .leftJoin(
      noticePreferences,
      and(
        eq(noticePreferences.workspaceId, workspaceMemberships.workspaceId),
        eq(noticePreferences.userId, workspaceMemberships.userId),
      ),
    )
    .leftJoin(
      noticeWorkspaceSettings,
      eq(noticeWorkspaceSettings.workspaceId, workspaceMemberships.workspaceId),
    )
    .where(
      and(
        eq(workspaceMemberships.status, 'active'),
        eq(workspaces.status, 'active'),
        sql`coalesce(${noticePreferences.mode},${noticeWorkspaceSettings.mode},'off')<>'off'`,
        or(
          isNull(noticePreferences.nextDueAt),
          sql`${noticePreferences.nextDueAt}<=clock_timestamp()`,
          sql`${noticePreferences.mode} is null and ${noticePreferences.scheduleDefaultRevision}<>coalesce(${noticeWorkspaceSettings.revision},0)`,
        ),
        after === undefined
          ? undefined
          : sql`(${workspaceMemberships.workspaceId},${workspaceMemberships.userId})>(${after.workspace_id}::uuid,${after.user_id}::uuid)`,
      ),
    )
    .orderBy(workspaceMemberships.workspaceId, workspaceMemberships.userId)
    .limit(limit)
    .catch(rethrowQueryFailure);
}

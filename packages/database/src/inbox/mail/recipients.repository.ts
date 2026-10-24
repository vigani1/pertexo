import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { alias } from 'drizzle-orm/pg-core';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  noticePreferences,
  noticeWorkspaceSettings,
} from '../../schema/inbox/preferences.js';
import {
  users as usersTable,
  workspaceMemberships as membershipsTable,
  workspaces,
} from '../../schema/foundation.js';
import type { PoolClient } from 'pg';
import type { NoticeSchedule } from '@pertexo/contracts';
import {
  projectNoticePreferences,
  type PreferenceRow,
} from '../preferences/settings.queries.js';
import { nextNoticeDue } from './schedule.js';

const users = alias(usersTable, 'person');
const workspaceMemberships = alias(membershipsTable, 'member');
export type Person = Readonly<{ workspace_id: string; user_id: string }>;
export async function recipient(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
) {
  const [found] = await drizzle(client)
    .select({
      email: users.email,
      workspace_name: workspaces.name,
      email_verified: users.emailVerified,
      role_revision: workspaceMemberships.roleRevision,
      created_at: workspaceMemberships.createdAt,
      now: sql<Date>`clock_timestamp()`.mapWith(workspaceMemberships.createdAt),
    })
    .from(users)
    .innerJoin(workspaceMemberships, eq(workspaceMemberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actorId),
        eq(workspaceMemberships.status, 'active'),
        eq(users.status, 'active'),
      ),
    )
    .for('share', { of: [users, workspaceMemberships] })
    .catch(rethrowQueryFailure);
  return found;
}
export async function settings(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  { create }: Readonly<{ create: boolean }>,
) {
  const db = drizzle(client);
  const [defaults] = await db
    .select()
    .from(noticeWorkspaceSettings)
    .where(eq(noticeWorkspaceSettings.workspaceId, workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  if (create)
    await db
      .insert(noticePreferences)
      .values({ workspaceId, userId: actorId })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  const [pref] = await db
    .select()
    .from(noticePreferences)
    .where(
      and(
        eq(noticePreferences.workspaceId, workspaceId),
        eq(noticePreferences.userId, actorId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const projected = projectNoticePreferences(pref, defaults, {
    canManageDefaults: false,
    emailAvailable: true,
  });
  const cut = new Date(
    Math.max(
      pref?.revision === 0 ? 0 : (pref?.changedAt.getTime() ?? 0),
      pref?.mode === null ? (defaults?.changedAt.getTime() ?? 0) : 0,
    ),
  );
  return {
    pref,
    defaults,
    effective: projected.effective,
    cut,
    defaultRevision: pref?.mode === null ? projected.defaults.revision : 0,
  };
}
export async function advance(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    schedule,
    now,
    defaultRevision,
  }: Readonly<{
    actorId: string;
    schedule: NoticeSchedule;
    now: Date;
    defaultRevision: number;
  }>,
) {
  await drizzle(client)
    .update(noticePreferences)
    .set({
      nextDueAt: nextNoticeDue(schedule, now),
      scheduleDefaultRevision: defaultRevision,
    })
    .where(
      and(
        eq(noticePreferences.workspaceId, workspaceId),
        eq(noticePreferences.userId, actorId),
      ),
    )
    .catch(rethrowQueryFailure);
}
export function nextPersonNoticeDue(
  pref: PreferenceRow,
  current: Awaited<ReturnType<typeof settings>>,
): Date | null {
  if (
    pref.nextDueAt !== null &&
    pref.scheduleDefaultRevision === current.defaultRevision
  ) {
    return pref.nextDueAt;
  }
  if (current.effective.mode === 'immediate') {
    return current.cut;
  }
  return nextNoticeDue(current.effective, current.cut);
}

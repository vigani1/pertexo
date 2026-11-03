import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { NoticePreferencesResponse } from '@pertexo/contracts';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  noticePreferences,
  noticeWorkspaceSettings,
} from '@pertexo/database/schema';
import { projectNoticePreferences } from './effective.js';

export async function readNoticePreferences(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    canManageDefaults,
    emailAvailable,
  }: Readonly<{
    actorId: string;
    canManageDefaults: boolean;
    emailAvailable: boolean;
  }>,
): Promise<NoticePreferencesResponse> {
  const db = drizzle(client);
  const pref = await db
    .select()
    .from(noticePreferences)
    .where(
      and(
        eq(noticePreferences.workspaceId, workspaceId),
        eq(noticePreferences.userId, actorId),
      ),
    )
    .catch(rethrowQueryFailure);
  const defs = await db
    .select()
    .from(noticeWorkspaceSettings)
    .where(eq(noticeWorkspaceSettings.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  return projectNoticePreferences(pref[0], defs[0], {
    canManageDefaults,
    emailAvailable,
  });
}

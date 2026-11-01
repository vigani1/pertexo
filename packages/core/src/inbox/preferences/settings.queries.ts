import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { NoticePreferencesResponse } from '@pertexo/contracts';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  noticePreferences,
  noticeWorkspaceSettings,
} from '@pertexo/database/schema';
export type PreferenceRow = typeof noticePreferences.$inferSelect;
export type DefaultsRow = typeof noticeWorkspaceSettings.$inferSelect;
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
export function projectNoticePreferences(
  pref: PreferenceRow | undefined,
  defs: DefaultsRow | undefined,
  {
    canManageDefaults,
    emailAvailable,
  }: Readonly<{ canManageDefaults: boolean; emailAvailable: boolean }>,
): NoticePreferencesResponse {
  const defaults = {
    revision: defs?.revision ?? 0,
    mode: defs?.mode ?? 'off',
    hour: defs?.hour ?? 9,
    timeZone: defs?.timeZone ?? 'UTC',
  };
  const personal = {
    revision: pref?.revision ?? 0,
    mode: pref?.mode ?? null,
    hour: pref?.hour ?? 9,
    timeZone: pref?.timeZone ?? 'UTC',
  };
  return {
    ...personal,
    defaults,
    effective:
      personal.mode === null
        ? {
            mode: defaults.mode,
            hour: defaults.hour,
            timeZone: defaults.timeZone,
          }
        : {
            mode: personal.mode,
            hour: personal.hour,
            timeZone: personal.timeZone,
          },
    canManageDefaults,
    emailAvailable,
    emailUnavailableReason: emailAvailable
      ? null
      : 'Email notifications need durable system mail. Ask the server operator to configure it. Your Inbox still works.',
  };
}

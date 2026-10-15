import type { PoolClient } from 'pg';
import {
  noticePreferencesResponseSchema,
  type NoticePreferencesResponse,
  type NoticeEmailMode,
} from '@pertexo/contracts';
export type PreferenceRow = Readonly<{
  revision: number;
  mode: NoticeEmailMode | null;
  hour: number;
  time_zone: string;
  changed_at: Date;
  next_due_at: Date | null;
  schedule_default_revision: number;
}>;
export type DefaultsRow = Readonly<{
  revision: number;
  mode: NoticeEmailMode;
  hour: number;
  time_zone: string;
  changed_at: Date;
}>;
export async function readNoticePreferences(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  canManageDefaults: boolean,
  emailAvailable: boolean,
): Promise<NoticePreferencesResponse> {
  const pref = await client.query<PreferenceRow>(
    'select * from app.notice_preferences where workspace_id=$1 and user_id=$2',
    [workspaceId, actorId],
  );
  const defs = await client.query<DefaultsRow>(
    'select * from app.notice_workspace_settings where workspace_id=$1',
    [workspaceId],
  );
  return projectNoticePreferences(
    pref.rows[0],
    defs.rows[0],
    canManageDefaults,
    emailAvailable,
  );
}
export function projectNoticePreferences(
  pref: PreferenceRow | undefined,
  defs: DefaultsRow | undefined,
  canManageDefaults: boolean,
  emailAvailable: boolean,
): NoticePreferencesResponse {
  const defaults = {
    revision: defs?.revision ?? 0,
    mode: defs?.mode ?? 'off',
    hour: defs?.hour ?? 9,
    timeZone: defs?.time_zone ?? 'UTC',
  };
  const personal = {
    revision: pref?.revision ?? 0,
    mode: pref?.mode ?? null,
    hour: pref?.hour ?? 9,
    timeZone: pref?.time_zone ?? 'UTC',
  };
  return noticePreferencesResponseSchema.parse({
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
  });
}

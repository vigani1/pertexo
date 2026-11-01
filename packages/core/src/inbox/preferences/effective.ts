import type { NoticePreferencesResponse } from '@pertexo/contracts';
import type {
  noticePreferences,
  noticeWorkspaceSettings,
} from '@pertexo/database/schema';

export type PreferenceRow = typeof noticePreferences.$inferSelect;
export type DefaultsRow = typeof noticeWorkspaceSettings.$inferSelect;

const DEFAULT_HOUR = 9;
const DEFAULT_TIME_ZONE = 'UTC';

/** A person's own choice, or the workspace's when they haven't made one. */
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
    hour: defs?.hour ?? DEFAULT_HOUR,
    timeZone: defs?.timeZone ?? DEFAULT_TIME_ZONE,
  };
  const personal = {
    revision: pref?.revision ?? 0,
    mode: pref?.mode ?? null,
    hour: pref?.hour ?? DEFAULT_HOUR,
    timeZone: pref?.timeZone ?? DEFAULT_TIME_ZONE,
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

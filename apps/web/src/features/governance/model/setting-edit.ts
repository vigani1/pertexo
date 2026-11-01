import {
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  type GovernanceSettings,
} from '@pertexo/contracts';

export type SettingField = Exclude<keyof GovernanceSettings, 'revision'>;

export const AUDIT_RETENTION_RANGE = `${String(AUDIT_RETENTION_MIN_DAYS)} to ${AUDIT_RETENTION_MAX_DAYS.toLocaleString('en-US')} days`;

/**
 * Every setting shares one revision, so any save moves it for the other forms.
 * A form is out of date only when its own setting changed since it last matched;
 * otherwise it saves against the newest revision. The server's revision check
 * still refuses a save from a page that hasn't seen a newer one.
 */
export function settingEdit(
  base: GovernanceSettings,
  snapshot: GovernanceSettings,
  field: SettingField,
): Readonly<{ stale: boolean; expectedRevision: number }> {
  // A snapshot older than the base is a save this form made, not yet in the cache.
  if (snapshot.revision <= base.revision)
    return { stale: false, expectedRevision: base.revision };
  return {
    stale: snapshot[field] !== base[field],
    expectedRevision: snapshot.revision,
  };
}

import type { Pool, PoolClient } from 'pg';

export type BetterAuthCutoverPreflight = Readonly<{
  activeUsersWithoutNativeMethod: number;
  activeUsersWithUnmigratedLegacyIdentity: number;
  liveLegacySessions: number;
}>;

/** Aggregate-only diagnostic. The durable marker proves exact-subject migration. */
export async function inspectBetterAuthCutover(
  pool: Pool | PoolClient,
): Promise<BetterAuthCutoverPreflight> {
  const result = await pool.query<{
    active_users_without_native_method: number;
    active_users_with_unmigrated_legacy_identity: number;
    live_legacy_sessions: number;
  }>(
    `select
       (select count(*)::integer from app.users users
         where users.status='active'
           and not exists (
             select 1 from app.auth_accounts account
              where account.user_id=users.id
           )) active_users_without_native_method,
       (select count(distinct identity.user_id)::integer
          from app.auth_identities identity
          join app.users users on users.id=identity.user_id
         where users.status='active'
           and identity.native_method_verified_at is null)
           active_users_with_unmigrated_legacy_identity,
       (select count(*)::integer from app.sessions session
         where session.revoked_at is null
           and session.expires_at>clock_timestamp()) live_legacy_sessions`,
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('Authentication cutover preflight did not return counts');
  return Object.freeze({
    activeUsersWithoutNativeMethod: row.active_users_without_native_method,
    activeUsersWithUnmigratedLegacyIdentity:
      row.active_users_with_unmigrated_legacy_identity,
    liveLegacySessions: row.live_legacy_sessions,
  });
}

export function assertBetterAuthCutoverReady(
  preflight: BetterAuthCutoverPreflight,
): void {
  if (Object.values(preflight).some((count) => count !== 0))
    throw new Error(
      'Authentication cutover requires verified legacy-account recovery and revoked old sessions',
    );
}

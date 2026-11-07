import type { Pool } from 'pg';

/** SDK account identifiers are projected to the product-owned provider labels. */
export async function readAccountProviderNames(
  pool: Pool,
  providerIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const providers = await pool.query<{ id: string; name: string }>(
    'select id,name from app.auth_providers where id::text=any($1::text[])',
    [providerIds],
  );
  return new Map(
    providers.rows.map((provider) => [provider.id, provider.name]),
  );
}

/** The adapter verifies this hash using the SDK's configured password algorithm. */
export async function readCredentialPasswordHash(
  pool: Pool,
  userId: string,
): Promise<string | undefined> {
  const credential = await pool.query<{ password: string | null }>(
    `select password from app.auth_accounts where user_id=$1 and provider_id='credential'`,
    [userId],
  );
  return credential.rows[0]?.password ?? undefined;
}

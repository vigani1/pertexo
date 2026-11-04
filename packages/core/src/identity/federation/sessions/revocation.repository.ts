import { withPlatformTransaction } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { authSessions } from '@pertexo/database/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

/** The trusted session boundary supplies a verified cookie's or freshly issued token. */
export async function revokeAuthenticationSession(
  pool: Pool,
  token: string,
): Promise<void> {
  await withPlatformTransaction(pool, async (client) => {
    await drizzle(client)
      .delete(authSessions)
      .where(eq(authSessions.token, token))
      .catch(rethrowQueryFailure);
  });
}

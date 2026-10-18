import type { Pool } from 'pg';
import { withPlatformTransaction } from '../../../tenant-access/transactions.js';
import { readEligibleAuthenticationSession } from './authority.js';

export function isAuthenticationSessionAllowed(
  pool: Pool,
  sessionId: string,
): Promise<boolean> {
  return withPlatformTransaction(
    pool,
    async (client) =>
      (await readEligibleAuthenticationSession(client, sessionId)) !==
      undefined,
  );
}

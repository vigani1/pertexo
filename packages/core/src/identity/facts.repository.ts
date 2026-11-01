import type { IdentitySecurityEvent } from './contract.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { identitySecurityAuditFacts } from '@pertexo/database/schema';

import { generatePersistedId } from '@pertexo/database/platform';

/** Accepts the caller's transaction when the fact must commit with an identity change. */
export async function recordIdentitySecurityFact(
  client: Pool | PoolClient,
  userId: string,
  event: IdentitySecurityEvent,
): Promise<void> {
  await drizzle(client).insert(identitySecurityAuditFacts).values({
    id: generatePersistedId(),
    userId,
    eventType: event,
  });
}

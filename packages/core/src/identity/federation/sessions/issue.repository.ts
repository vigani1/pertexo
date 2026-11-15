import { authSessions } from '@pertexo/database/schema';
import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SECOND_INTERVAL } from '../../../shared/sql-intervals.repository.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { SessionAuthenticationProof } from './policy.js';

const SESSION_TOKEN_BYTES = 32;

/** The one place a session and its opaque token are written outside Better Auth. */
export async function issueSession(
  client: PoolClient,
  userId: string,
  ttlSeconds: number,
  proof: SessionAuthenticationProof,
): Promise<string> {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  await drizzle(client)
    .insert(authSessions)
    .values({
      id: generatePersistedId(),
      userId,
      token,
      expiresAt: sql`clock_timestamp()+(${ttlSeconds}::integer*${SECOND_INTERVAL})`,
      authenticationMethod: proof.method,
      ...(proof.method === 'organization'
        ? {
            federationProviderId: proof.providerId,
            federationProviderRevision: proof.providerRevision,
          }
        : {}),
    })
    .catch(rethrowQueryFailure);
  return token;
}

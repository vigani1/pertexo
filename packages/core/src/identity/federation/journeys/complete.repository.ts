import {
  authFederationAttempts,
  authProviderChecks,
} from '@pertexo/database/schema';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { findFederationAttempt } from './federation-journeys.repository.js';

type FederationAttempt = NonNullable<
  Awaited<ReturnType<typeof findFederationAttempt>>
>;

/** Records that this provider revision passed its test on the domain. */
export async function recordProviderCheck(
  client: PoolClient,
  attempt: FederationAttempt,
): Promise<void> {
  await drizzle(client)
    .insert(authProviderChecks)
    .values({
      organizationId: attempt.provider.organizationId,
      domainId: attempt.domainId,
      providerId: attempt.provider.id,
      providerRevision: attempt.provider.revision,
    })
    .onConflictDoUpdate({
      target: [
        authProviderChecks.organizationId,
        authProviderChecks.domainId,
        authProviderChecks.providerId,
      ],
      set: {
        providerRevision: attempt.provider.revision,
        testedAt: sql`clock_timestamp()`,
      },
    })
    .catch(rethrowQueryFailure);
}

export async function consumeAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<void> {
  await drizzle(client)
    .update(authFederationAttempts)
    .set({ consumedAt: sql`clock_timestamp()` })
    .where(eq(authFederationAttempts.id, attemptId))
    .catch(rethrowQueryFailure);
}

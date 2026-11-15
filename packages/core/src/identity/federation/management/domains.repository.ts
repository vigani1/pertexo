import { authDomains } from '@pertexo/database/schema';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { domainRecords } from './identity-organizations.repository.js';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DomainRow } from './identity-organizations.repository.js';
import { DAY_INTERVAL } from '../../../shared/sql-intervals.repository.js';

// A domain's verification challenge, and how long it can be answered.
const CHALLENGE_BYTES = 32;
const CHALLENGE_LIFETIME_DAYS = 7;
const CHALLENGE_LIFETIME = sql`${CHALLENGE_LIFETIME_DAYS}*${DAY_INTERVAL}`;

const newDomainChallenge = () => ({
  challenge: randomBytes(CHALLENGE_BYTES).toString('base64url'),
  challengeExpiresAt: sql`clock_timestamp()+${CHALLENGE_LIFETIME}`,
});

export async function lockOrganizationDomain(
  client: PoolClient,
  organizationId: string,
  domainId: string,
): Promise<DomainRow | undefined> {
  const [domain] = await domainRecords(client)
    .where(
      and(
        eq(authDomains.organizationId, organizationId),
        eq(authDomains.id, domainId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return domain;
}

export async function domainConfigured(
  client: PoolClient,
  organizationId: string,
  domain: string,
): Promise<boolean> {
  const found = await drizzle(client)
    .select({ id: authDomains.id })
    .from(authDomains)
    .where(
      and(
        eq(authDomains.organizationId, organizationId),
        eq(authDomains.domain, domain),
      ),
    )
    .catch(rethrowQueryFailure);
  return found.length !== 0;
}

/** Adds the domain with a fresh challenge. */
export async function insertDomain(
  client: PoolClient,
  input: Readonly<{ id: string; organizationId: string; domain: string }>,
): Promise<void> {
  await drizzle(client)
    .insert(authDomains)
    .values({ ...input, ...newDomainChallenge() })
    .catch(rethrowQueryFailure);
}

export async function renewChallenge(
  client: PoolClient,
  domainId: string,
): Promise<void> {
  await drizzle(client)
    .update(authDomains)
    .set({
      ...newDomainChallenge(),
      revision: sql`${authDomains.revision}+1`,
    })
    .where(eq(authDomains.id, domainId))
    .catch(rethrowQueryFailure);
}

/** Whether the observed challenge is the domain's live, unanswered one. */
export async function challengeMatches(
  client: PoolClient,
  domainId: string,
  observedChallenge: string,
): Promise<boolean> {
  const found = await drizzle(client)
    .select({ id: authDomains.id })
    .from(authDomains)
    .where(
      and(
        eq(authDomains.id, domainId),
        eq(authDomains.challenge, observedChallenge),
        gt(authDomains.challengeExpiresAt, sql`clock_timestamp()`),
        isNull(authDomains.verifiedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return found.length === 1;
}

/** Serializes claims of one domain name, then says whether any organization verified it. */
export async function lockDomainClaim(
  client: PoolClient,
  domain: string,
): Promise<boolean> {
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`identity-domain:${domain}`},0))`,
    )
    .catch(rethrowQueryFailure);
  const claimed = await drizzle(client)
    .select({ id: authDomains.id })
    .from(authDomains)
    .where(
      and(eq(authDomains.domain, domain), isNotNull(authDomains.verifiedAt)),
    )
    .catch(rethrowQueryFailure);
  return claimed.length !== 0;
}

export async function markDomainVerified(
  client: PoolClient,
  domainId: string,
): Promise<void> {
  await drizzle(client)
    .update(authDomains)
    .set({
      verifiedAt: sql`clock_timestamp()`,
      challenge: null,
      challengeExpiresAt: null,
      revision: sql`${authDomains.revision}+1`,
    })
    .where(eq(authDomains.id, domainId))
    .catch(rethrowQueryFailure);
}

export async function deleteDomain(
  client: PoolClient,
  domainId: string,
): Promise<void> {
  await drizzle(client)
    .delete(authDomains)
    .where(eq(authDomains.id, domainId))
    .catch(rethrowQueryFailure);
}

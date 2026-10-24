import { authDomains } from '../../../schema/identity/federation/domains.js';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { domainRecords } from './records.queries.js';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { FederationConflictError } from './errors.js';
import type { DomainRow } from './records.queries.js';
import { recordFederationAudit } from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './commands.repository.js';
import type { FederationCommand } from './contract.js';
import { requireResourceCapacity } from './organizations.repository.js';

export async function requireOrganizationDomain(
  client: PoolClient,
  organizationId: string,
  domainId: string,
): Promise<DomainRow> {
  const [domain] = await domainRecords(client)
    .where(
      and(
        eq(authDomains.organizationId, organizationId),
        eq(authDomains.id, domainId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (domain === undefined)
    throw new FederationConflictError(
      'unavailable',
      'That domain is unavailable.',
    );
  return domain;
}
export function createDomain(
  pool: Pool,
  input: FederationCommand & Readonly<{ domain: string }>,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.domain.create',
    request: { domain: input.domain, expectedRevision: input.expectedRevision },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      await requireResourceCapacity(client, organization.id, 'domains');
      if (
        (
          await drizzle(client)
            .select({ id: authDomains.id })
            .from(authDomains)
            .where(
              and(
                eq(authDomains.organizationId, organization.id),
                eq(authDomains.domain, input.domain),
              ),
            )
            .catch(rethrowQueryFailure)
        ).length !== 0
      )
        throw new FederationConflictError(
          'unavailable',
          'That domain is already configured.',
        );
      const id = generatePersistedId();
      await drizzle(client)
        .insert(authDomains)
        .values({
          id,
          organizationId: organization.id,
          domain: input.domain,
          challenge: randomBytes(32).toString('base64url'),
          challengeExpiresAt: sql`clock_timestamp()+interval '7 days'`,
        })
        .catch(rethrowQueryFailure);
      await recordFederationAudit(client, input, {
        action: 'identity.domain_challenge_created',
        targetId: organization.id,
        metadata: { domainId: id, domain: input.domain },
      });
      return advanceOrganization(client, organization);
    },
  });
}
export function renewDomainChallenge(
  pool: Pool,
  input: FederationCommand & Readonly<{ domainId: string }>,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.domain.renew',
    request: {
      domainId: input.domainId,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const domain = await requireOrganizationDomain(
        client,
        organization.id,
        input.domainId,
      );
      if (domain.verified_at !== null)
        throw new FederationConflictError(
          'unavailable',
          'This domain is already verified.',
        );
      await drizzle(client)
        .update(authDomains)
        .set({
          challenge: randomBytes(32).toString('base64url'),
          challengeExpiresAt: sql`clock_timestamp()+interval '7 days'`,
          revision: sql`${authDomains.revision}+1`,
        })
        .where(eq(authDomains.id, domain.id))
        .catch(rethrowQueryFailure);
      await recordFederationAudit(client, input, {
        action: 'identity.domain_challenge_created',
        targetId: organization.id,
        metadata: { domainId: domain.id, domain: domain.domain },
      });
      return advanceOrganization(client, organization);
    },
  });
}
/** DNS is resolved before this transaction; the exact observed challenge is consumed under lock. */
export function verifyDomain(
  pool: Pool,
  input: FederationCommand &
    Readonly<{ domainId: string; observedChallenge: string }>,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.domain.verify',
    request: {
      domainId: input.domainId,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const domain = await requireOrganizationDomain(
        client,
        organization.id,
        input.domainId,
      );
      const valid =
        (
          await drizzle(client)
            .select({ id: authDomains.id })
            .from(authDomains)
            .where(
              and(
                eq(authDomains.id, domain.id),
                eq(authDomains.challenge, input.observedChallenge),
                gt(authDomains.challengeExpiresAt, sql`clock_timestamp()`),
                isNull(authDomains.verifiedAt),
              ),
            )
            .catch(rethrowQueryFailure)
        ).length === 1;
      if (!valid)
        throw new FederationConflictError(
          'dns_unverified',
          'The DNS challenge changed or expired. Check the current TXT record.',
        );
      await drizzle(client)
        .execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`identity-domain:${domain.domain}`},0))`,
        )
        .catch(rethrowQueryFailure);
      if (
        (
          await drizzle(client)
            .select({ id: authDomains.id })
            .from(authDomains)
            .where(
              and(
                eq(authDomains.domain, domain.domain),
                isNotNull(authDomains.verifiedAt),
              ),
            )
            .catch(rethrowQueryFailure)
        ).length !== 0
      )
        throw new FederationConflictError(
          'domain_claimed',
          'This domain is already claimed on this install.',
        );
      await drizzle(client)
        .update(authDomains)
        .set({
          verifiedAt: sql`clock_timestamp()`,
          challenge: null,
          challengeExpiresAt: null,
          revision: sql`${authDomains.revision}+1`,
        })
        .where(eq(authDomains.id, domain.id))
        .catch(rethrowQueryFailure);
      await recordFederationAudit(client, input, {
        action: 'identity.domain_verified',
        targetId: organization.id,
        metadata: { domainId: domain.id, domain: domain.domain },
      });
      return advanceOrganization(client, organization);
    },
  });
}
export function removeDomain(
  pool: Pool,
  input: FederationCommand & Readonly<{ domainId: string }>,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.domain.remove',
    request: {
      domainId: input.domainId,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const domain = await requireOrganizationDomain(
        client,
        organization.id,
        input.domainId,
      );
      if (domain.require_sso)
        throw new FederationConflictError(
          'unavailable',
          'Turn off required SSO before removing this domain.',
        );
      await drizzle(client)
        .delete(authDomains)
        .where(eq(authDomains.id, domain.id))
        .catch(rethrowQueryFailure);
      await recordFederationAudit(client, input, {
        action: 'identity.domain_removed',
        targetId: organization.id,
        metadata: { domainId: domain.id, domain: domain.domain },
      });
      return advanceOrganization(client, organization);
    },
  });
}

import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { generatePersistedId } from '@pertexo/database/platform';
import { FederationConflictError } from './federation-management.errors.js';
import type { DomainRow } from './identity-organizations.repository.js';
import { recordFederationAudit } from './authority.repository.js';
import { advanceOrganization } from './commands.repository.js';
import {
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './federation-authority.js';
import type {
  CreateDomainInput,
  DomainCommand,
  VerifyDomainInput,
} from './federation-management.types.js';
import { requireResourceCapacity } from './organizations.js';
import {
  challengeMatches,
  deleteDomain,
  domainConfigured,
  insertDomain,
  lockDomainClaim,
  lockOrganizationDomain,
  markDomainVerified,
  renewChallenge,
} from './domains.repository.js';

export async function requireOrganizationDomain(
  client: PoolClient,
  organizationId: string,
  domainId: string,
): Promise<DomainRow> {
  const domain = await lockOrganizationDomain(client, organizationId, domainId);
  if (domain === undefined)
    throw new FederationConflictError(
      'unavailable',
      'That domain is unavailable.',
    );
  return domain;
}
export function createDomain(
  pool: Pool,
  input: CreateDomainInput,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.domain.create',
    request: { domain: input.domain, expectedRevision: input.expectedRevision },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      await requireResourceCapacity(client, organization.id, 'domains');
      if (await domainConfigured(client, organization.id, input.domain))
        throw new FederationConflictError(
          'unavailable',
          'That domain is already configured.',
        );
      const id = generatePersistedId();
      await insertDomain(client, {
        id,
        organizationId: organization.id,
        domain: input.domain,
      });
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
  input: DomainCommand,
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
      await renewChallenge(client, domain.id);
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
  input: VerifyDomainInput,
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
      const valid = await challengeMatches(
        client,
        domain.id,
        input.observedChallenge,
      );
      if (!valid)
        throw new FederationConflictError(
          'dns_unverified',
          'The DNS challenge changed or expired. Check the current TXT record.',
        );
      if (await lockDomainClaim(client, domain.domain))
        throw new FederationConflictError(
          'domain_claimed',
          'This domain is already claimed on this install.',
        );
      await markDomainVerified(client, domain.id);
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
  input: DomainCommand,
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
      await deleteDomain(client, domain.id);
      await recordFederationAudit(client, input, {
        action: 'identity.domain_removed',
        targetId: organization.id,
        metadata: { domainId: domain.id, domain: domain.domain },
      });
      return advanceOrganization(client, organization);
    },
  });
}

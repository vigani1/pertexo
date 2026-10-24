import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { FederationConflictError, type DomainRow } from './contract.js';
import { recordFederationAudit } from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
  type FederationCommand,
} from './commands.repository.js';
import { requireResourceCapacity } from './organizations.repository.js';

export async function requireOrganizationDomain(
  client: PoolClient,
  organizationId: string,
  domainId: string,
): Promise<DomainRow> {
  const domain = (
    await client.query<DomainRow>(
      'select * from app.auth_domains where organization_id=$1 and id=$2 for update',
      [organizationId, domainId],
    )
  ).rows[0];
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
          await client.query(
            'select id from app.auth_domains where organization_id=$1 and domain=$2',
            [organization.id, input.domain],
          )
        ).rowCount !== 0
      )
        throw new FederationConflictError(
          'unavailable',
          'That domain is already configured.',
        );
      const id = generatePersistedId();
      await client.query(
        "insert into app.auth_domains(id,organization_id,domain,challenge,challenge_expires_at) values($1,$2,$3,$4,clock_timestamp()+interval '7 days')",
        [
          id,
          organization.id,
          input.domain,
          randomBytes(32).toString('base64url'),
        ],
      );
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
      await client.query(
        "update app.auth_domains set challenge=$2,challenge_expires_at=clock_timestamp()+interval '7 days',revision=revision+1 where id=$1",
        [domain.id, randomBytes(32).toString('base64url')],
      );
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
          await client.query(
            'select id from app.auth_domains where id=$1 and challenge=$2 and challenge_expires_at>clock_timestamp() and verified_at is null',
            [domain.id, input.observedChallenge],
          )
        ).rowCount === 1;
      if (!valid)
        throw new FederationConflictError(
          'dns_unverified',
          'The DNS challenge changed or expired. Check the current TXT record.',
        );
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`identity-domain:${domain.domain}`],
      );
      if (
        (
          await client.query(
            'select id from app.auth_domains where domain=$1 and verified_at is not null',
            [domain.domain],
          )
        ).rowCount !== 0
      )
        throw new FederationConflictError(
          'domain_claimed',
          'This domain is already claimed on this install.',
        );
      await client.query(
        'update app.auth_domains set verified_at=clock_timestamp(),challenge=null,challenge_expires_at=null,revision=revision+1 where id=$1',
        [domain.id],
      );
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
      await client.query('delete from app.auth_domains where id=$1', [
        domain.id,
      ]);
      await recordFederationAudit(client, input, {
        action: 'identity.domain_removed',
        targetId: organization.id,
        metadata: { domainId: domain.id, domain: domain.domain },
      });
      return advanceOrganization(client, organization);
    },
  });
}

import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { FederationConflictError } from './federation-management.errors.js';
import { recordFederationAudit } from './authority.repository.js';
import { advanceOrganization } from './commands.repository.js';
import {
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './federation-authority.js';
import type { ConfigureEnforcementInput } from './federation-management.types.js';
import { requireOrganizationDomain } from './domains.js';
import {
  domainHasTestedProvider,
  hasUntestedRequiredDomain,
  ownerHasRecoveryCredential,
  readControlOwner,
  setDomainRequirement,
} from './enforcement.repository.js';

async function requireRecoveryCredential(
  client: PoolClient,
  controlWorkspaceId: string,
): Promise<string> {
  const owner = await readControlOwner(client, controlWorkspaceId);
  if (
    owner === undefined ||
    !(await ownerHasRecoveryCredential(client, owner.user_id))
  )
    throw new FederationConflictError(
      'recovery_required',
      'The control workspace owner needs a verified account with a working password before SSO can be required.',
    );
  return owner.user_id;
}
/** A policy must retain a successfully tested enabled provider for every required domain. */
export async function assertRequiredDomainsReady(
  client: PoolClient,
  organizationId: string,
  excludingProviderId?: string,
): Promise<void> {
  if (
    await hasUntestedRequiredDomain(client, organizationId, excludingProviderId)
  )
    throw new FederationConflictError(
      'provider_untested',
      'Turn off required SSO or test another enabled provider before changing this provider.',
    );
}
export function configureDomainEnforcement(
  pool: Pool,
  input: ConfigureEnforcementInput,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.domain.enforcement',
    request: {
      domainId: input.domainId,
      required: input.required,
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
      if (input.required) {
        if (domain.verified_at === null)
          throw new FederationConflictError(
            'dns_unverified',
            'Verify the domain DNS record before requiring SSO.',
          );
        await requireRecoveryCredential(
          client,
          organization.control_workspace_id,
        );
        if (
          !(await domainHasTestedProvider(client, organization.id, domain.id))
        )
          throw new FederationConflictError(
            'provider_untested',
            'Complete a test sign-in with an enabled provider for this domain first.',
          );
      }
      if (domain.require_sso !== input.required) {
        await setDomainRequirement(client, domain, input.required);
        await recordFederationAudit(client, input, {
          action: 'identity.domain_enforcement_changed',
          targetId: organization.id,
          metadata: { domainId: domain.id, required: input.required },
        });
        return advanceOrganization(client, organization);
      }
      return organization;
    },
  });
}

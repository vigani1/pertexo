import type { Pool } from 'pg';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { withPlatformTransaction } from '@pertexo/database/platform';
import { withWorkspaceAccess } from '../../../shared/access/workspace-access.js';
import {
  lockFederationWorkspace,
  requireFederationOwner,
} from '../management/federation-authority.js';
import { organizationForWorkspace } from '../management/authority.repository.js';
import { FederationConflictError } from '../management/federation-management.errors.js';
import type { FederationScope } from '../management/federation-management.types.js';
import { readEligibleAuthenticationSession } from '../sessions/authority.repository.js';
import { SignInProofRejectedError } from '../accounts/sign-in-proof.errors.js';
import { readFederationProvider } from './federation-journeys.repository.js';
import {
  insertFederationAttempt,
  readProviderControlWorkspace,
  readVerifiedDomain,
  shareLockWorkspace,
} from './organization-sign-in.repository.js';
import type { StartFederationJourney } from './federation-journey.types.js';

/** Only the control workspace's owner may test a provider, against a domain it verified. */
export function testOrganizationProvider(
  pool: Pool,
  input: FederationScope & Readonly<{ providerId: string; domainId: string }>,
) {
  return withWorkspaceAccess(
    pool,
    input,
    {
      mode: 'exclusive',
      capability: 'governance:manage',
      statuses: ACTIVE_WORKSPACE_STATUSES,
    },
    async (client, role) => {
      requireFederationOwner(role, 'change');
      const organization = await organizationForWorkspace(
        client,
        input.workspaceId,
      );
      if (organization?.control_workspace_id !== input.workspaceId)
        throw new FederationConflictError(
          'unavailable',
          'The provider or verified domain is unavailable.',
        );
      const domain = await readVerifiedDomain(
        client,
        input.domainId,
        organization.id,
      );
      if (domain === undefined)
        throw new FederationConflictError(
          'unavailable',
          'The provider or verified domain is unavailable.',
        );
      const material = await readFederationProvider(
        client,
        input.providerId,
        domain,
        { testing: true },
      );
      if (material?.provider.organizationId !== organization.id)
        throw new FederationConflictError(
          'unavailable',
          'The provider or verified domain is unavailable.',
        );
      return material;
    },
  );
}

/** The attempt is written only for a provider whose revision and domain still match. */
export async function startFederationJourney(
  pool: Pool,
  input: StartFederationJourney,
): Promise<void> {
  await withPlatformTransaction(pool, async (client) => {
    const controlWorkspaceId = await readProviderControlWorkspace(
      client,
      input.providerId,
    );
    if (controlWorkspaceId === undefined) throw new SignInProofRejectedError();
    if (input.purpose === 'test') {
      if (input.ownerUserId === undefined || input.ownerSessionId === undefined)
        throw new SignInProofRejectedError();
      await lockFederationWorkspace(client, {
        workspaceId: controlWorkspaceId,
        actorId: input.ownerUserId,
      });
      if (
        (await readEligibleAuthenticationSession(client, input.ownerSessionId))
          ?.userId !== input.ownerUserId
      )
        throw new SignInProofRejectedError();
    } else await shareLockWorkspace(client, controlWorkspaceId);
    const inserted = await insertFederationAttempt(client, input);
    if (!inserted) throw new SignInProofRejectedError();
  });
}

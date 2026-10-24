import { isUniqueConstraintFailure } from '../../../platform/query-errors.js';
import { FEDERATION_LIMITS } from '@pertexo/workflow-model';
import { FEDERATION_WORKSPACE_STATUSES } from '../sessions/policy.js';
import type { Pool } from 'pg';
import type { FederationDiscovery } from '@pertexo/contracts';
import { withPlatformTransaction } from '../../../tenant-access/transactions.js';
import {
  lockFederationWorkspace,
  organizationForWorkspace,
} from '../management/authority.repository.js';
import {
  FederationConflictError,
  type FederationScope,
} from '../management/contract.js';
import { readEligibleAuthenticationSession } from '../sessions/authority.repository.js';
import { SignInProofRejectedError } from '../accounts/rejection.js';
import { queryFailure } from '../../../platform/query-errors.js';
import { readFederationProvider, findFederationAttempt } from './records.queries.js';
import {
  completeFederationJourney,
  type CompleteFederationJourney,
} from './complete.repository.js';
import type {
  StartFederationJourney,
  FederationCompletion,
} from './contract.js';

export class OrganizationSignInCommands {
  constructor(
    private readonly input: Readonly<{ pool: Pool; sessionTtlSeconds: number }>,
  ) {}
  async discover(domain: string): Promise<FederationDiscovery> {
    const result = await this.input.pool.query<{
      require_sso: boolean;
      id: string | null;
      name: string | null;
      kind: 'oidc' | 'saml' | null;
    }>(
      `select domain.require_sso,provider.id,provider.name,provider.kind from app.auth_domains domain join app.auth_organizations organization on organization.id=domain.organization_id join app.workspaces control on control.id=organization.control_workspace_id left join app.auth_providers provider on provider.organization_id=domain.organization_id and provider.enabled where domain.domain=$1 and control.status=any($2::text[]) and domain.verified_at is not null order by provider.name,provider.id limit $3`,
      [domain, [...FEDERATION_WORKSPACE_STATUSES], FEDERATION_LIMITS.providers],
    );
    return {
      required: result.rows[0]?.require_sso ?? false,
      providers: result.rows.flatMap(({ id, name, kind }) => {
        const providerUnavailable =
          id === null || name === null || kind === null;
        return providerUnavailable ? [] : [{ id, name, kind }];
      }),
    };
  }
  provider(providerId: string, domain: string) {
    return readFederationProvider(this.input.pool, providerId, domain);
  }
  async testProvider(
    input: FederationScope & Readonly<{ providerId: string; domainId: string }>,
  ) {
    return withPlatformTransaction(this.input.pool, async (client) => {
      await lockFederationWorkspace(client, input, { ownerOnly: true });
      const organization = await organizationForWorkspace(
        client,
        input.workspaceId,
      );
      if (organization?.control_workspace_id !== input.workspaceId)
        throw new FederationConflictError(
          'unavailable',
          'The provider or verified domain is unavailable.',
        );
      const domain = (
        await client.query<{ domain: string }>(
          'select domain from app.auth_domains where id=$1 and organization_id=$2 and verified_at is not null',
          [input.domainId, organization.id],
        )
      ).rows[0];
      if (domain === undefined)
        throw new FederationConflictError(
          'unavailable',
          'The provider or verified domain is unavailable.',
        );
      const material = await readFederationProvider(
        client,
        input.providerId,
        domain.domain,
        { testing: true },
      );
      if (material?.provider.organizationId !== organization.id)
        throw new FederationConflictError(
          'unavailable',
          'The provider or verified domain is unavailable.',
        );
      return material;
    });
  }
  async start(input: StartFederationJourney): Promise<void> {
    await withPlatformTransaction(this.input.pool, async (client) => {
      const provider = (
        await client.query<{ control_workspace_id: string }>(
          `select organization.control_workspace_id from app.auth_providers provider join app.auth_organizations organization on organization.id=provider.organization_id where provider.id=$1`,
          [input.providerId],
        )
      ).rows[0];
      if (provider === undefined) throw new SignInProofRejectedError();
      if (input.purpose === 'test') {
        if (
          input.ownerUserId === undefined ||
          input.ownerSessionId === undefined
        )
          throw new SignInProofRejectedError();
        await lockFederationWorkspace(
          client,
          {
            workspaceId: provider.control_workspace_id,
            actorId: input.ownerUserId,
          },
          { ownerOnly: true },
        );
        if (
          (
            await readEligibleAuthenticationSession(
              client,
              input.ownerSessionId,
            )
          )?.userId !== input.ownerUserId
        )
          throw new SignInProofRejectedError();
      } else
        await client.query(
          'select id from app.workspaces where id=$1 for share',
          [provider.control_workspace_id],
        );
      const inserted = await client.query(
        `insert into app.auth_federation_attempts(id,organization_id,provider_id,provider_revision,domain_id,purpose,owner_user_id,owner_session_id,state_digest,browser_digest,return_path,expires_at)
   select $1,provider.organization_id,provider.id,provider.revision,domain.id,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '5 minutes' from app.auth_providers provider
   join app.auth_organizations organization on organization.id=provider.organization_id join app.workspaces control on control.id=organization.control_workspace_id
   join app.auth_domains domain on domain.organization_id=provider.organization_id and domain.verified_at is not null
   where provider.id=$8 and provider.revision=$9 and domain.id=$10 and control.status=any($11::text[]) and (provider.enabled or $2='test')`,
        [
          input.id,
          input.purpose,
          input.ownerUserId ?? null,
          input.ownerSessionId ?? null,
          input.stateDigest,
          input.browserDigest,
          input.returnPath,
          input.providerId,
          input.providerRevision,
          input.domainId,
          [...FEDERATION_WORKSPACE_STATUSES],
        ],
      );
      if (inserted.rowCount !== 1) throw new SignInProofRejectedError();
    });
  }
  find(stateDigest: Buffer, browserDigest: Buffer) {
    return findFederationAttempt(this.input.pool, stateDigest, browserDigest);
  }
  complete(input: CompleteFederationJourney): Promise<FederationCompletion> {
    return withPlatformTransaction(this.input.pool, (client) =>
      completeFederationJourney(client, input, this.input.sessionTtlSeconds),
    ).catch((error: unknown) => {
      const cause = queryFailure(error);
      const proofRefused =
        error instanceof SignInProofRejectedError ||
        isUniqueConstraintFailure(cause);
      if (proofRefused) return { kind: 'failed' } as const;
      throw error;
    });
  }
}

import { directorySessionAllowed } from '../provisioning/session.queries.js';
import { AUTHENTICATION_PROVIDERS } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';
import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../../tenant-access/transactions.js';
import {
  authenticationAllowed,
  accountPolicy,
  sessionProof,
  identityEmailChangeAllowed,
  type AuthenticationPolicy,
  type SessionAuthenticationProof,
  type CurrentProvider,
  FEDERATION_WORKSPACE_STATUSES,
} from './policy.js';

async function readAuthenticationPolicy(
  client: PoolClient,
  userId: string,
): Promise<AuthenticationPolicy> {
  const account = (
    await client.query<{
      status: string;
      email_verified: boolean;
      organization_id: string | null;
      require_sso: boolean | null;
      control_workspace_id: string | null;
    }>(
      `select users.status,users.email_verified,domain.organization_id,domain.require_sso,organization.control_workspace_id from app.users users
 left join app.auth_domains domain on domain.domain=lower(split_part(users.email,'@',2)) and domain.verified_at is not null
 left join app.auth_organizations organization on organization.id=domain.organization_id where users.id=$1`,
      [userId],
    )
  ).rows[0];
  if (account === undefined)
    return {
      active: false,
      enforcedOrganizationId: null,
      verifiedOrganizationId: null,
      recoveryOwner: false,
    };
  let controlOwner = false;
  let passwordPresent = false;
  const controlWorkspaceId = account.control_workspace_id;
  const requiresOrganizationSignIn =
    (account.require_sso ?? false) &&
    controlWorkspaceId !== null &&
    account.email_verified;
  if (requiresOrganizationSignIn) {
    controlOwner = await withWorkspaceScope(
      client,
      { workspaceId: controlWorkspaceId },
      async (scoped) =>
        (
          await scoped.query(
            "select 1 from app.workspace_memberships member join app.workspaces workspace on workspace.id=member.workspace_id where member.workspace_id=$1 and member.user_id=$2 and member.role='owner' and member.status='active'",
            [account.control_workspace_id, userId],
          )
        ).rowCount === 1,
    );
    passwordPresent =
      controlOwner &&
      (
        await client.query(
          "select 1 from app.auth_accounts where user_id=$1 and provider_id='credential' and password is not null and length(password)>0",
          [userId],
        )
      ).rowCount === 1;
  }
  return accountPolicy({
    ...account,
    control_owner: controlOwner,
    password_present: passwordPresent,
  });
}
export async function canCreateAuthenticationSession(
  client: PoolClient,
  userId: string,
  proof: SessionAuthenticationProof,
): Promise<boolean> {
  const policy = await readAuthenticationPolicy(client, userId);
  let provider: CurrentProvider | undefined;
  if (proof.method === 'organization') {
    const row = (
      await client.query<{
        organization_id: string;
        enabled: boolean;
        revision: number;
      }>(
        'select provider.organization_id,provider.enabled,provider.revision from app.auth_providers provider join app.auth_organizations organization on organization.id=provider.organization_id join app.workspaces control on control.id=organization.control_workspace_id where provider.id=$1 and control.status=any($2::text[])',
        [proof.providerId, [...FEDERATION_WORKSPACE_STATUSES]],
      )
    ).rows[0];
    if (row !== undefined)
      provider = {
        organizationId: row.organization_id,
        enabled: row.enabled,
        revision: row.revision,
        directoryAllowed: await directorySessionAllowed(
          client,
          row.organization_id,
          userId,
        ),
      };
  }
  return authenticationAllowed(policy, proof, provider);
}
export type AuthenticationSession = Readonly<{
  id: string;
  userId: string;
  proof: SessionAuthenticationProof;
}>;
export async function readEligibleAuthenticationSession(
  client: PoolClient,
  sessionId: string,
): Promise<AuthenticationSession | undefined> {
  const session = (
    await client.query<{
      id: string;
      user_id: string;
      authentication_method: 'credential' | 'social' | 'organization';
      federation_provider_id: string | null;
      federation_provider_revision: number | null;
    }>(
      `select id,user_id,authentication_method,federation_provider_id,federation_provider_revision from app.auth_sessions where id=$1 and expires_at>clock_timestamp()`,
      [sessionId],
    )
  ).rows[0];
  if (session === undefined) return undefined;
  const proof = sessionProof(session);
  if (!(await canCreateAuthenticationSession(client, session.user_id, proof)))
    return undefined;
  return { id: session.id, userId: session.user_id, proof };
}
export function authorizeCredentialSignIn(
  pool: Pool,
  userId: string,
  transaction?: PoolClient,
): Promise<'allowed' | 'recovery' | 'sso_required' | 'inactive'> {
  const authorize = async (
    client: PoolClient,
  ): Promise<'allowed' | 'recovery' | 'sso_required' | 'inactive'> => {
    const policy = await readAuthenticationPolicy(client, userId);
    if (!policy.active) return 'inactive';
    if (!authenticationAllowed(policy, { method: 'credential' }))
      return 'sso_required';
    if (!policy.recoveryOwner) return 'allowed';
    const domain = (
      await client.query<{ control_workspace_id: string }>(
        `select control_workspace_id from app.auth_organizations where id=$1`,
        [policy.enforcedOrganizationId],
      )
    ).rows[0];
    if (domain === undefined) return 'sso_required';
    await withWorkspaceScope(
      client,
      { workspaceId: domain.control_workspace_id },
      async (scoped) => {
        await appendAuditFact(scoped, {
          workspaceId: domain.control_workspace_id,
          actorId: userId,
          action: 'identity.recovery_authorized',
          targetType: 'identity_organization',
          targetId:
            policy.enforcedOrganizationId ?? domain.control_workspace_id,
        });
      },
    );
    return 'recovery';
  };
  return transaction === undefined
    ? withPlatformTransaction(pool, authorize)
    : authorize(transaction);
}

export type IdentityEmailChangeEligibility =
  'allowed' | 'managed' | 'alternative_required';
/** Organization-only accounts need a usable method if their primary address leaves the verified domain. */
export async function readIdentityEmailChangeEligibility(
  client: PoolClient,
  userId: string,
): Promise<IdentityEmailChangeEligibility> {
  if (
    !identityEmailChangeAllowed(await readAuthenticationPolicy(client, userId))
  )
    return 'managed';
  const methods = (
    await client.query<{ provider_id: string; password_configured: boolean }>(
      'select provider_id,(password is not null and length(password)>0) password_configured from app.auth_accounts where user_id=$1',
      [userId],
    )
  ).rows;
  const isSocial = (providerId: string) =>
    AUTHENTICATION_PROVIDERS.some((provider) => provider === providerId);
  const organizationOnly =
    methods.some(
      (method) =>
        method.provider_id !== 'credential' && !isSocial(method.provider_id),
    ) &&
    !methods.some((method) =>
      method.provider_id === 'credential'
        ? method.password_configured
        : isSocial(method.provider_id),
    );
  return organizationOnly ? 'alternative_required' : 'allowed';
}
export function identityEmailChangeEligibility(
  pool: Pool,
  userId: string,
): Promise<IdentityEmailChangeEligibility> {
  return withPlatformTransaction(pool, (client) =>
    readIdentityEmailChangeEligibility(client, userId),
  );
}

import {
  users,
  workspaceMemberships,
  workspaces,
} from '../../../schema/foundation.js';
import { authDomains } from '../../../schema/identity/federation/domains.js';
import { authOrganizations } from '../../../schema/identity/federation/organizations.js';
import { authAccounts, authSessions } from '../../../schema/authentication.js';
import { authProviders } from '../../../schema/identity/federation/providers.js';
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
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
  const [account] = await drizzle(client)
    .select({
      status: users.status,
      email_verified: users.emailVerified,
      organization_id: authDomains.organizationId,
      require_sso: authDomains.requireSso,
      control_workspace_id: authOrganizations.controlWorkspaceId,
    })
    .from(users)
    .leftJoin(
      authDomains,
      and(
        sql`${authDomains.domain}=lower(split_part(${users.email},'@',2))`,
        isNotNull(authDomains.verifiedAt),
      ),
    )
    .leftJoin(
      authOrganizations,
      eq(authOrganizations.id, authDomains.organizationId),
    )
    .where(eq(users.id, userId))
    .catch(rethrowQueryFailure);
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
          await drizzle(scoped)
            .select({ one: sql`1` })
            .from(workspaceMemberships)
            .innerJoin(
              workspaces,
              eq(workspaces.id, workspaceMemberships.workspaceId),
            )
            .where(
              and(
                eq(workspaceMemberships.workspaceId, controlWorkspaceId),
                eq(workspaceMemberships.userId, userId),
                eq(workspaceMemberships.role, 'owner'),
                eq(workspaceMemberships.status, 'active'),
              ),
            )
            .catch(rethrowQueryFailure)
        ).length === 1,
    );
    passwordPresent =
      controlOwner &&
      (
        await drizzle(client)
          .select({ one: sql`1` })
          .from(authAccounts)
          .where(
            and(
              eq(authAccounts.userId, userId),
              eq(authAccounts.providerId, 'credential'),
              isNotNull(authAccounts.password),
              sql`length(${authAccounts.password})>0`,
            ),
          )
          .catch(rethrowQueryFailure)
      ).length === 1;
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
    const [row] = await drizzle(client)
      .select({
        organization_id: authProviders.organizationId,
        enabled: authProviders.enabled,
        revision: authProviders.revision,
      })
      .from(authProviders)
      .innerJoin(
        authOrganizations,
        eq(authOrganizations.id, authProviders.organizationId),
      )
      .innerJoin(
        workspaces,
        eq(workspaces.id, authOrganizations.controlWorkspaceId),
      )
      .where(
        and(
          eq(authProviders.id, proof.providerId),
          inArray(workspaces.status, FEDERATION_WORKSPACE_STATUSES),
        ),
      )
      .catch(rethrowQueryFailure);
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
  const [session] = await drizzle(client)
    .select({
      id: authSessions.id,
      user_id: authSessions.userId,
      authentication_method: authSessions.authenticationMethod,
      federation_provider_id: authSessions.federationProviderId,
      federation_provider_revision: authSessions.federationProviderRevision,
    })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.id, sessionId),
        gt(authSessions.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .catch(rethrowQueryFailure);
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
    const [domain] = await drizzle(client)
      .select({ control_workspace_id: authOrganizations.controlWorkspaceId })
      .from(authOrganizations)
      .where(eq(authOrganizations.id, sql`${policy.enforcedOrganizationId}`))
      .catch(rethrowQueryFailure);
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
  const methods = await drizzle(client)
    .select({
      provider_id: authAccounts.providerId,
      password_configured: sql<boolean>`(${authAccounts.password} is not null and length(${authAccounts.password})>0)`,
    })
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId))
    .catch(rethrowQueryFailure);
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

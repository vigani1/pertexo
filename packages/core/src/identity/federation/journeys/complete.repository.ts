import { canonicalEmail } from '@pertexo/workflow-model';
import type { CompleteFederationJourney } from './contract.js';
import {
  authAccounts,
  authSessions,
  authFederationAttempts,
  authProviderChecks,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withWorkspaceScope,
  appendAuditFact,
} from '@pertexo/database/primitives';
import { lockDirectoryOrganization } from '../provisioning/authority.repository.js';
import {
  bindDirectorySignIn,
  directorySignInCandidate,
} from '../provisioning/sign-in.repository.js';
import { hasSignInMethodCapacity } from '../accounts/limits.queries.js';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import { lockWorkspaceAuthority } from '../../../shared/authority.queries.js';
import { revokeUserSessions } from '../../../tenant-access/users/sessions.repository.js';
import { recordIdentitySecurityFact } from '../../facts.repository.js';
import { resolveVerifiedSignInUser } from '../accounts/resolve.repository.js';
import { SignInProofRejectedError } from '../accounts/rejection.js';
import {
  canCreateAuthenticationSession,
  readEligibleAuthenticationSession,
} from '../sessions/authority.repository.js';
import { findFederationAttempt } from './records.queries.js';
import { grantJustInTimeMemberships } from './membership.repository.js';
import type { FederationCompletion } from './contract.js';
export async function completeFederationJourney(
  client: PoolClient,
  input: CompleteFederationJourney,
  ttlSeconds: number,
): Promise<FederationCompletion> {
  const preview = await findFederationAttempt(
    client,
    input.stateDigest,
    input.browserDigest,
  );
  if (preview?.id !== input.attemptId) throw new SignInProofRejectedError();
  const organization = await lockDirectoryOrganization(
    client,
    preview.provider.organizationId,
  );
  const currentWorkspaces = organization.workspaces;
  const attempt = await findFederationAttempt(
    client,
    input.stateDigest,
    input.browserDigest,
    { locking: true },
  );
  if (
    attempt?.id !== input.attemptId ||
    input.identity.email.split('@')[1] !== attempt.domain
  )
    throw new SignInProofRejectedError();
  if (attempt.purpose === 'test')
    return completeProviderTest(client, input, attempt);
  const directory = await directorySignInCandidate(client, organization.id, {
    email: input.identity.email,
    providerId: attempt.provider.id,
    subject: input.identity.subject,
  });
  const user = await resolveVerifiedSignInUser(client, {
    provider: attempt.provider.id,
    identity: {
      accountId: input.identity.subject,
      email: input.identity.email,
      emailVerified: true,
      displayName: input.identity.displayName,
    },
    // An organization vouches for its own domain: sign-up settings don't apply.
    mayCreateUser: () =>
      directory !== undefined || attempt.provider.configuration.jitEnabled,
  });
  if (user?.status !== 'active' || !user.email_verified)
    throw new SignInProofRejectedError();
  if (directory !== undefined)
    await bindDirectorySignIn(client, organization, directory, user.id);
  const proof = {
    method: 'organization',
    providerId: attempt.provider.id,
    providerRevision: attempt.provider.revision,
  } as const;
  if (!(await canCreateAuthenticationSession(client, user.id, proof)))
    throw new SignInProofRejectedError();
  const [linked] = await drizzle(client)
    .select({ user_id: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, attempt.provider.id),
        eq(authAccounts.accountId, input.identity.subject),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (linked !== undefined && linked.user_id !== user.id)
    throw new SignInProofRejectedError();
  if (linked === undefined) {
    if (!(await hasSignInMethodCapacity(client, user.id)))
      throw new SignInProofRejectedError();
    if (canonicalEmail(user.email) !== canonicalEmail(input.identity.email))
      throw new SignInProofRejectedError();
    await drizzle(client)
      .insert(authAccounts)
      .values({
        id: generatePersistedId(),
        userId: user.id,
        providerId: attempt.provider.id,
        accountId: input.identity.subject,
      })
      .catch(rethrowQueryFailure);
    await revokeUserSessions(client, user.id);
    await recordIdentitySecurityFact(client, user.id, 'method.linked');
  }
  if (directory === undefined && attempt.provider.configuration.jitEnabled)
    await grantJustInTimeMemberships(
      client,
      currentWorkspaces,
      user.id,
      attempt.provider.organizationId,
    );
  const token = randomBytes(32).toString('base64url');
  await drizzle(client)
    .insert(authSessions)
    .values({
      id: generatePersistedId(),
      userId: user.id,
      token,
      expiresAt: sql`clock_timestamp()+(${ttlSeconds}::integer*interval '1 second')`,
      authenticationMethod: 'organization',
      federationProviderId: attempt.provider.id,
      federationProviderRevision: attempt.provider.revision,
    })
    .catch(rethrowQueryFailure);
  await recordIdentitySecurityFact(client, user.id, 'session.signed_in');
  await withWorkspaceScope(
    client,
    { workspaceId: attempt.provider.controlWorkspaceId },
    (scoped) =>
      appendAuditFact(scoped, {
        workspaceId: attempt.provider.controlWorkspaceId,
        actorId: user.id,
        action: 'identity.session_signed_in',
        targetType: 'identity_organization',
        targetId: attempt.provider.organizationId,
        metadata: { providerId: attempt.provider.id },
      }),
  );
  await drizzle(client)
    .update(authFederationAttempts)
    .set({ consumedAt: sql`clock_timestamp()` })
    .where(eq(authFederationAttempts.id, attempt.id))
    .catch(rethrowQueryFailure);
  return { kind: 'signed_in', token, returnPath: attempt.returnPath };
}

async function completeProviderTest(
  client: PoolClient,
  input: CompleteFederationJourney,
  attempt: NonNullable<Awaited<ReturnType<typeof findFederationAttempt>>>,
): Promise<FederationCompletion> {
  const invalidOwnerSession =
    attempt.ownerUserId === null ||
    attempt.ownerSessionId === null ||
    attempt.ownerSessionId !== input.ownerSessionId;
  if (invalidOwnerSession) throw new SignInProofRejectedError();
  const source = await readEligibleAuthenticationSession(
    client,
    attempt.ownerSessionId,
  );
  if (source?.userId !== attempt.ownerUserId)
    throw new SignInProofRejectedError();
  await withWorkspaceScope(
    client,
    {
      workspaceId: attempt.provider.controlWorkspaceId,
      actorId: attempt.ownerUserId,
    },
    (scoped) =>
      lockWorkspaceAuthority(
        scoped,
        attempt.provider.controlWorkspaceId,
        attempt.ownerUserId ?? '',
        ['owner'],
      ),
  );
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
  await withWorkspaceScope(
    client,
    { workspaceId: attempt.provider.controlWorkspaceId },
    (scoped) =>
      appendAuditFact(scoped, {
        workspaceId: attempt.provider.controlWorkspaceId,
        actorId: attempt.ownerUserId,
        action: 'identity.provider_tested',
        targetType: 'identity_organization',
        targetId: attempt.provider.organizationId,
        metadata: {
          providerId: attempt.provider.id,
          domainId: attempt.domainId,
          providerRevision: attempt.provider.revision,
        },
      }),
  );
  await drizzle(client)
    .update(authFederationAttempts)
    .set({ consumedAt: sql`clock_timestamp()` })
    .where(eq(authFederationAttempts.id, attempt.id))
    .catch(rethrowQueryFailure);
  return { kind: 'tested', returnPath: attempt.returnPath };
}

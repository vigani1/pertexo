import { hasSignInMethodCapacity } from '../accounts/limits.js';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../../tenant-access/workspaces/authority.js';
import { revokeUserSessions } from '../../../tenant-access/users/sessions.js';
import { appendAuditFact } from '../../../governance/audit/append.js';
import { recordIdentitySecurityFact } from '../../security-facts.js';
import { resolveVerifiedSignInUser } from '../accounts/resolve.js';
import { SignInProofRejectedError } from '../accounts/rejection.js';
import {
  canCreateAuthenticationSession,
  readEligibleAuthenticationSession,
} from '../sessions/authority.js';
import { findFederationAttempt } from './queries.js';
import {
  grantJustInTimeMemberships,
  type LinkedWorkspace,
} from './membership.js';
import type { FederationIdentity, FederationCompletion } from './contract.js';

export type CompleteFederationJourney = Readonly<{
  attemptId: string;
  stateDigest: Buffer;
  browserDigest: Buffer;
  identity: FederationIdentity;
  ownerSessionId?: string;
}>;
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
  const workspaces = (
    await client.query<LinkedWorkspace>(
      'select workspace_id,default_role from app.auth_organization_workspaces where organization_id=$1 order by workspace_id',
      [preview.provider.organizationId],
    )
  ).rows;
  for (const workspace of workspaces)
    await client.query('select id from app.workspaces where id=$1 for update', [
      workspace.workspace_id,
    ]);
  const organization = (
    await client.query(
      'select id from app.auth_organizations where id=$1 for update',
      [preview.provider.organizationId],
    )
  ).rowCount;
  if (organization !== 1) throw new SignInProofRejectedError();
  const currentWorkspaces = (
    await client.query<LinkedWorkspace>(
      'select workspace_id,default_role from app.auth_organization_workspaces where organization_id=$1 order by workspace_id',
      [preview.provider.organizationId],
    )
  ).rows;
  if (
    workspaces.length !== currentWorkspaces.length ||
    workspaces.some(
      (workspace, index) =>
        workspace.workspace_id !== currentWorkspaces[index]?.workspace_id,
    )
  )
    throw new SignInProofRejectedError();
  const attempt = await findFederationAttempt(
    client,
    input.stateDigest,
    input.browserDigest,
    true,
  );
  if (
    attempt?.id !== input.attemptId ||
    input.identity.email.split('@')[1] !== attempt.domain
  )
    throw new SignInProofRejectedError();
  if (attempt.purpose === 'test') {
    if (
      attempt.ownerUserId === null ||
      attempt.ownerSessionId === null ||
      attempt.ownerSessionId !== input.ownerSessionId
    )
      throw new SignInProofRejectedError();
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
    await client.query(
      `insert into app.auth_provider_checks(organization_id,domain_id,provider_id,provider_revision) values($1,$2,$3,$4)
   on conflict(organization_id,domain_id,provider_id) do update set provider_revision=excluded.provider_revision,tested_at=clock_timestamp()`,
      [
        attempt.provider.organizationId,
        attempt.domainId,
        attempt.provider.id,
        attempt.provider.revision,
      ],
    );
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
    await client.query(
      'update app.auth_federation_attempts set consumed_at=clock_timestamp() where id=$1',
      [attempt.id],
    );
    return { kind: 'tested', returnPath: attempt.returnPath };
  }
  const user = await resolveVerifiedSignInUser(client, {
    provider: attempt.provider.id,
    identity: {
      accountId: input.identity.subject,
      email: input.identity.email,
      emailVerified: true,
      displayName: input.identity.displayName,
    },
    createUser: attempt.provider.configuration.jitEnabled,
  });
  if (user?.status !== 'active' || !user.email_verified)
    throw new SignInProofRejectedError();
  const proof = {
    method: 'organization',
    providerId: attempt.provider.id,
    providerRevision: attempt.provider.revision,
  } as const;
  if (!(await canCreateAuthenticationSession(client, user.id, proof)))
    throw new SignInProofRejectedError();
  const linked = (
    await client.query<{ user_id: string }>(
      'select user_id from app.auth_accounts where provider_id=$1 and account_id=$2 for update',
      [attempt.provider.id, input.identity.subject],
    )
  ).rows[0];
  if (linked !== undefined && linked.user_id !== user.id)
    throw new SignInProofRejectedError();
  if (linked === undefined) {
    if (!(await hasSignInMethodCapacity(client, user.id)))
      throw new SignInProofRejectedError();
    if (user.email.toLowerCase() !== input.identity.email)
      throw new SignInProofRejectedError();
    await client.query(
      'insert into app.auth_accounts(id,user_id,provider_id,account_id) values($1,$2,$3,$4)',
      [
        generatePersistedId(),
        user.id,
        attempt.provider.id,
        input.identity.subject,
      ],
    );
    await revokeUserSessions(client, user.id);
    await recordIdentitySecurityFact(client, user.id, 'method.linked');
  }
  if (attempt.provider.configuration.jitEnabled)
    await grantJustInTimeMemberships(
      client,
      currentWorkspaces,
      user.id,
      attempt.provider.organizationId,
    );
  const token = randomBytes(32).toString('base64url');
  await client.query(
    `insert into app.auth_sessions(id,user_id,token,expires_at,authentication_method,federation_provider_id,federation_provider_revision)
 values($1,$2,$3,clock_timestamp()+($4::integer*interval '1 second'),'organization',$5,$6)`,
    [
      generatePersistedId(),
      user.id,
      token,
      ttlSeconds,
      attempt.provider.id,
      attempt.provider.revision,
    ],
  );
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
  await client.query(
    'update app.auth_federation_attempts set consumed_at=clock_timestamp() where id=$1',
    [attempt.id],
  );
  return { kind: 'signed_in', token, returnPath: attempt.returnPath };
}

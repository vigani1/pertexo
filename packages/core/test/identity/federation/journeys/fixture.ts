import { randomUUID, createHash } from 'node:crypto';

import { OrganizationSignInCommands } from '../../../../src/identity/index.js';
import { useIdentityCommandDatabase } from '../../command.support.js';

export const db = useIdentityCommandDatabase('oidc_proof');

export const key = () => randomUUID();

export const digest = () => createHash('sha256').update(key()).digest();

export async function setup(jitEnabled = false) {
  const owner = await db.user('Recovery owner'),
    workspaceId = await db.workspace(owner.id);
  const scope = { workspaceId, actorId: owner.id };
  const created = await db.federation().createOrganization({
    ...scope,
    name: 'Example organization',
    idempotencyKey: key(),
  });
  const domain = `${key()}.example.test`;
  const pending = await db.federation().createDomain({
    ...scope,
    domain,
    expectedRevision: 1,
    idempotencyKey: key(),
  });
  const domainId = pending.organization?.domains[0]?.id;
  if (domainId === undefined) throw new Error('Missing domain');
  const challenge = await db
    .federation()
    .domainChallenge({ ...scope, domainId });
  await db.federation().verifyDomain({
    ...scope,
    domainId,
    observedChallenge: challenge.challenge,
    expectedRevision: 2,
    idempotencyKey: key(),
  });
  const configured = await db.federation().createProvider({
    ...scope,
    name: 'Example OIDC',
    issuer: 'https://idp.example.test/tenant',
    configuration: {
      clientId: 'client',
      emailClaim: 'email',
      nameClaim: 'name',
      jitEnabled,
    },
    enabled: true,
    sealSecret: (id) => ({ ciphertext: 'sealed-private', provider: id }),
    secretFingerprint: 'purpose-bound-test-fingerprint',
    expectedRevision: 3,
    idempotencyKey: key(),
  });
  const providerId = configured.organization?.providers[0]?.id,
    organizationId = created.organization?.id;
  if (providerId === undefined || organizationId === undefined)
    throw new Error('Missing provider');
  const commands = new OrganizationSignInCommands({
    pool: db.authenticationPool(),
    sessionTtlSeconds: 3600,
  });
  return {
    owner,
    scope,
    domain,
    domainId,
    providerId,
    organizationId,
    commands,
  };
}

export async function begin(
  fixture: Awaited<ReturnType<typeof setup>>,
  purpose: 'sign_in' | 'test' = 'sign_in',
  ownerSessionId?: string,
) {
  const { commands, domain, providerId, domainId, owner } = fixture;
  const material = await commands.provider(providerId, domain);
  if (material === undefined) throw new Error('Missing provider material');
  const attempt = {
    id: key(),
    providerId,
    providerRevision: material.provider.revision,
    domainId,
    purpose,
    stateDigest: digest(),
    browserDigest: digest(),
    returnPath: '/workspaces',
    ...(purpose === 'test'
      ? { ownerUserId: owner.id, ownerSessionId: ownerSessionId ?? '' }
      : {}),
  };
  await commands.start(attempt);
  return { ...attempt, attemptId: attempt.id };
}

export async function ownerSession(fixture: Awaited<ReturnType<typeof setup>>) {
  const token = await db.sessions(fixture.owner.id);
  const [session] = await db.asAdmin<{ id: string }>(
    'select id from app.auth_sessions where token=$1',
    [token],
  );
  if (session === undefined) throw new Error('Missing owner session');
  return session.id;
}

export async function verifiedUser(domain: string, name = 'Member') {
  const user = await db.user(name);
  const email = `${key()}@${domain}`;
  await db.asAdmin(
    'update app.users set email=$2,email_verified=true where id=$1',
    [user.id, email],
  );
  return { ...user, email };
}

export async function sessionId(token: string) {
  const [session] = await db.asAdmin<{ id: string }>(
    'select id from app.auth_sessions where token=$1',
    [token],
  );
  if (session === undefined) throw new Error('Missing session');
  return session.id;
}

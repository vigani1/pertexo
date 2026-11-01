import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAccessDeniedError } from '../../../src/tenant-access/errors.js';
import { useIdentityCommandDatabase } from '../command.support.js';
const db = useIdentityCommandDatabase('oidc_manage');
const key = () => randomUUID();
async function setup() {
  const user = await db.user('Organization owner');
  const workspaceId = await db.workspace(user.id);
  const scope = { workspaceId, actorId: user.id };
  const settings = await db.federation().createOrganization({
    ...scope,
    name: 'Example organization',
    idempotencyKey: key(),
  });
  const organization = settings.organization;
  if (organization === null) throw new Error('Organization was not created');
  return { scope, user, organization };
}
const oidc = {
  clientId: 'example-client',
  emailClaim: 'email',
  nameClaim: 'name',
  jitEnabled: false,
};
async function addDomain(
  scope: { workspaceId: string; actorId: string },
  expectedRevision: number,
  domain = `${key()}.example.test`,
) {
  const result = await db.federation().createDomain({
    ...scope,
    domain,
    expectedRevision,
    idempotencyKey: key(),
  });
  const created = result.organization?.domains.find(
    (entry) => entry.domain === domain,
  );
  if (created === undefined) throw new Error('Domain was not created');
  return { created, result };
}
describe('organization federation management', () => {
  it('creates and replays once, projects safe settings, and audits in the same transaction', async () => {
    const user = await db.user('Create owner');
    const workspaceId = await db.workspace(user.id);
    const scope = { workspaceId, actorId: user.id };
    const command = { ...scope, name: 'Organization', idempotencyKey: key() };
    const settings = await db.federation().createOrganization(command);
    await expect(db.federation().createOrganization(command)).resolves.toEqual(
      settings,
    );
    await expect(
      db.federation().createOrganization({ ...command, name: 'Changed' }),
    ).rejects.toHaveProperty('name', 'IdempotencyConflictError');
    await expect(
      db.asAdmin(
        'select id from app.audit_events where workspace_id=$1 and action=$2',
        [workspaceId, 'identity.organization_created'],
      ),
    ).resolves.toHaveLength(1);
    await expect(db.federation().settings(scope)).resolves.toEqual(settings);
  });
  it('lets admins read but refuses builders and non-owners before sealing a secret', async () => {
    const { scope } = await setup();
    const admin = await db.user('Admin'),
      builder = await db.user('Builder');
    await db.member(scope.workspaceId, admin.id, 'admin');
    await db.member(scope.workspaceId, builder.id, 'builder');
    await expect(
      db.federation().settings({ ...scope, actorId: admin.id }),
    ).resolves.toHaveProperty('canManage', false);
    await expect(
      db.federation().settings({ ...scope, actorId: builder.id }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    const sealSecret = vi.fn(() => ({ ciphertext: 'never' }));
    await expect(
      db.federation().createProvider({
        ...scope,
        actorId: admin.id,
        name: 'Provider',
        issuer: 'https://idp.example.test',
        configuration: oidc,
        enabled: false,
        sealSecret,
        secretFingerprint: 'test-only-fingerprint',
        expectedRevision: 1,
        idempotencyKey: key(),
      }),
    ).rejects.toHaveProperty('reason', 'owner_required');
    expect(sealSecret).not.toHaveBeenCalled();
  });
  it('requires ownership of both linked workspaces and control-workspace authority', async () => {
    const { scope, organization } = await setup();
    const other = await db.user('Other owner'),
      foreign = await db.workspace(other.id);
    await db.member(foreign, scope.actorId, 'admin');
    await expect(
      db.federation().linkWorkspace({
        ...scope,
        targetWorkspaceId: foreign,
        defaultRole: 'viewer',
        expectedRevision: organization.revision,
        idempotencyKey: key(),
      }),
    ).rejects.toHaveProperty('reason', 'owner_required');
    const target = await db.workspace(scope.actorId);
    const linked = await db.federation().linkWorkspace({
      ...scope,
      targetWorkspaceId: target,
      defaultRole: 'builder',
      expectedRevision: organization.revision,
      idempotencyKey: key(),
    });
    expect(linked.organization?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: target,
          defaultRole: 'builder',
        }),
      ]),
    );
    await expect(
      db.federation().createDomain({
        ...scope,
        workspaceId: target,
        domain: 'example.test',
        expectedRevision: 2,
        idempotencyKey: key(),
      }),
    ).rejects.toHaveProperty('reason', 'owner_required');
    await expect(
      db.asAdmin(
        'select workspace_id from app.audit_events where target_id=$1 and action=$2',
        [organization.id, 'identity.workspace_linked'],
      ),
    ).resolves.toHaveLength(2);
  });
  it('consumes only the observed current DNS challenge, rejecting replaced and expired challenges', async () => {
    const { scope } = await setup();
    const { created } = await addDomain(scope, 1);
    const original = await db
      .federation()
      .domainChallenge({ ...scope, domainId: created.id });
    await db.federation().renewDomainChallenge({
      ...scope,
      domainId: created.id,
      expectedRevision: 2,
      idempotencyKey: key(),
    });
    await expect(
      db.federation().verifyDomain({
        ...scope,
        domainId: created.id,
        observedChallenge: original.challenge,
        expectedRevision: 3,
        idempotencyKey: key(),
      }),
    ).rejects.toHaveProperty('reason', 'dns_unverified');
    const current = await db
      .federation()
      .domainChallenge({ ...scope, domainId: created.id });
    expect(current.challenge).not.toBe(original.challenge);
    await db.asAdmin(
      "update app.auth_domains set challenge_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [created.id],
    );
    await expect(
      db.federation().verifyDomain({
        ...scope,
        domainId: created.id,
        observedChallenge: current.challenge,
        expectedRevision: 3,
        idempotencyKey: key(),
      }),
    ).rejects.toHaveProperty('reason', 'dns_unverified');
    await db.federation().renewDomainChallenge({
      ...scope,
      domainId: created.id,
      expectedRevision: 3,
      idempotencyKey: key(),
    });
    const fresh = await db
      .federation()
      .domainChallenge({ ...scope, domainId: created.id });
    const command = {
      ...scope,
      domainId: created.id,
      observedChallenge: fresh.challenge,
      expectedRevision: 4,
      idempotencyKey: key(),
    };
    const verified = await db.federation().verifyDomain(command);
    expect(verified.organization?.domains[0]).toMatchObject({
      challenge: null,
      revision: 4,
      requireSso: false,
    });
    expect(verified.organization?.domains[0]?.verifiedAt).not.toBeNull();
    await expect(db.federation().verifyDomain(command)).resolves.toEqual(
      verified,
    );
  });
  it('permits only one organization to claim an exact domain across competing commands', async () => {
    const a = await setup(),
      b = await setup();
    const domain = `${key()}.example.test`;
    const da = await addDomain(a.scope, 1, domain),
      dB = await addDomain(b.scope, 1, domain);
    const ca = await db
        .federation()
        .domainChallenge({ ...a.scope, domainId: da.created.id }),
      cb = await db
        .federation()
        .domainChallenge({ ...b.scope, domainId: dB.created.id });
    const results = await Promise.allSettled([
      db.federation().verifyDomain({
        ...a.scope,
        domainId: da.created.id,
        observedChallenge: ca.challenge,
        expectedRevision: 2,
        idempotencyKey: key(),
      }),
      db.federation(1).verifyDomain({
        ...b.scope,
        domainId: dB.created.id,
        observedChallenge: cb.challenge,
        expectedRevision: 2,
        idempotencyKey: key(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .map((result): unknown => result.reason),
    ).toEqual([expect.objectContaining({ reason: 'domain_claimed' })]);
  });
  it('serializes same-revision writes and leaves no partial command or audit after a stale change', async () => {
    const { scope } = await setup();
    const results = await Promise.allSettled(
      ['first.example.test', 'second.example.test'].map((domain) =>
        db.federation().createDomain({
          ...scope,
          domain,
          expectedRevision: 1,
          idempotencyKey: key(),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .map((result): unknown => result.reason),
    ).toEqual([expect.objectContaining({ reason: 'stale' })]);
    const settings = await db.federation().settings(scope);
    expect(settings.organization?.domains).toHaveLength(1);
    expect(settings.organization?.revision).toBe(2);
    await expect(
      db.asAdmin(
        'select id from app.idempotency_records where workspace_id=$1',
        [scope.workspaceId],
      ),
    ).resolves.toHaveLength(2);
  });
  it('keeps provider secrets and fingerprints out of settings, audit facts and command results', async () => {
    const { scope } = await setup();
    const secret = 'private-ciphertext-marker',
      fingerprint = 'private-fingerprint-marker';
    const sealSecret = vi.fn((id: string) => ({
      ciphertext: secret,
      associatedProviderId: id,
    }));
    const command = {
      ...scope,
      name: 'Work OIDC',
      issuer: 'https://idp.example.test/tenant',
      configuration: oidc,
      enabled: true,
      sealSecret,
      secretFingerprint: fingerprint,
      expectedRevision: 1,
      idempotencyKey: key(),
    };
    const created = await db.federation().createProvider(command);
    await expect(db.federation().createProvider(command)).resolves.toEqual(
      created,
    );
    expect(sealSecret).toHaveBeenCalledTimes(1);
    const provider = created.organization?.providers[0];
    expect(provider).toMatchObject({
      kind: 'oidc',
      secretConfigured: true,
      revision: 1,
    });
    expect(sealSecret).toHaveBeenCalledWith(provider?.id);
    for (const rows of [
      created,
      await db.federation().settings(scope),
      await db.asAdmin(
        'select metadata from app.audit_events where workspace_id=$1',
        [scope.workspaceId],
      ),
      await db.asAdmin(
        'select result_ref from app.idempotency_records where workspace_id=$1',
        [scope.workspaceId],
      ),
    ]) {
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(JSON.stringify(rows)).not.toContain(fingerprint);
    }
    await expect(
      db
        .federation()
        .createProvider({ ...command, secretFingerprint: 'different' }),
    ).rejects.toHaveProperty('name', 'IdempotencyConflictError');
  });
  it('rolls back a failed seal without persisting a provider, revision or command', async () => {
    const { scope } = await setup();
    await expect(
      db.federation().createProvider({
        ...scope,
        name: 'Bad secret',
        issuer: 'https://idp.example.test',
        configuration: oidc,
        enabled: false,
        sealSecret: () => {
          throw new Error('sealed failure');
        },
        secretFingerprint: 'test-only',
        expectedRevision: 1,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow('sealed failure');
    const settings = await db.federation().settings(scope);
    expect(settings.organization?.revision).toBe(1);
    expect(settings.organization?.providers).toHaveLength(0);
    await expect(
      db.asAdmin(
        'select id from app.idempotency_records where workspace_id=$1',
        [scope.workspaceId],
      ),
    ).resolves.toHaveLength(1);
  });
  it('refuses enforcement until DNS, a tested provider and recovery credential are ready', async () => {
    const { scope } = await setup();
    const { created } = await addDomain(scope, 1);
    const command = {
      ...scope,
      domainId: created.id,
      required: true,
      expectedRevision: 2,
      idempotencyKey: key(),
    };
    await expect(
      db.federation().configureEnforcement(command),
    ).rejects.toHaveProperty('reason', 'dns_unverified');
    const challenge = await db
      .federation()
      .domainChallenge({ ...scope, domainId: created.id });
    await db.federation().verifyDomain({
      ...scope,
      domainId: created.id,
      observedChallenge: challenge.challenge,
      expectedRevision: 2,
      idempotencyKey: key(),
    });
    await expect(
      db.federation().configureEnforcement({ ...command, expectedRevision: 3 }),
    ).rejects.toHaveProperty('reason', 'recovery_required');
    await db.asAdmin('update app.users set email_verified=true where id=$1', [
      scope.actorId,
    ]);
    await db.asAdmin(
      "insert into app.auth_accounts(id,user_id,provider_id,account_id,password) values($1,$2::uuid,'credential',$3,'test-password-hash')",
      [key(), scope.actorId, scope.actorId],
    );
    await expect(
      db.federation().configureEnforcement({ ...command, expectedRevision: 3 }),
    ).rejects.toHaveProperty('reason', 'provider_untested');
  });
});

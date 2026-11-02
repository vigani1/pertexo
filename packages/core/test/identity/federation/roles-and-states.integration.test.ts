import { randomBytes, randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createFederationManagementStore,
  isAuthenticationSessionAllowed,
  OrganizationSignInCommands,
} from '../../../src/identity/index.js';
import { createDirectoryCredential } from '../../../src/identity/federation/provisioning/management/credentials.repository.js';
import { createDirectoryStore } from '../../../src/identity/federation/provisioning/store.js';
import { WorkspaceAccessDeniedError } from '../../../src/tenant-access/errors.js';
import { useIdentityCommandDatabase } from '../command.support.js';

const db = useIdentityCommandDatabase('identity_roles');

let pool: Pool;
let federation: ReturnType<typeof createFederationManagementStore>;
let directory: ReturnType<typeof createDirectoryStore>;
let signIn: OrganizationSignInCommands;

beforeAll(async () => {
  const [row] = await db.asAdmin<{ name: string }>(
    'select current_database() as name',
  );
  const url = new URL(
    process.env.DATABASE_URL ??
      'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
  );
  url.pathname = `/${String(row?.name)}`;
  const config = () =>
    parseDatabaseConfig({ connectionString: url.toString(), max: 3 });
  pool = new Pool({ connectionString: url.toString(), max: 3 });
  federation = createFederationManagementStore(config());
  directory = createDirectoryStore(config());
  signIn = new OrganizationSignInCommands({ pool, sessionTtlSeconds: 3_600 });
});

afterAll(async () => {
  await Promise.all([federation.close(), directory.close(), pool.end()]);
});

const key = () => randomUUID();
const oidc = {
  clientId: 'example-client',
  emailClaim: 'email',
  nameClaim: 'name',
  jitEnabled: false,
};

/** An organization ready to sign in through, with a linked workspace beside it. */
async function organization() {
  const owner = await db.user('Owner'),
    control = await db.workspace(owner.id),
    linked = await db.workspace(owner.id);
  const scope = { workspaceId: control, actorId: owner.id };
  const domain = `${randomUUID()}.example.test`;
  const made = await federation.createOrganization({
    ...scope,
    name: 'Roles',
    idempotencyKey: key(),
  });
  if (made.organization === null) throw new Error('Organization missing');
  await federation.linkWorkspace({
    ...scope,
    targetWorkspaceId: linked,
    defaultRole: 'viewer',
    expectedRevision: 1,
    idempotencyKey: key(),
  });
  const added = await federation.createDomain({
    ...scope,
    domain,
    expectedRevision: 2,
    idempotencyKey: key(),
  });
  const created = added.organization?.domains[0];
  if (created === undefined) throw new Error('Domain missing');
  const pending = await federation.createDomain({
    ...scope,
    domain: `${randomUUID()}.example.test`,
    expectedRevision: 3,
    idempotencyKey: key(),
  });
  const pendingDomain = pending.organization?.domains.find(
    (entry) => entry.id !== created.id,
  );
  if (pendingDomain === undefined) throw new Error('Domain missing');
  const { challenge } = await federation.domainChallenge({
    ...scope,
    domainId: created.id,
  });
  const verifyKey = key();
  await federation.verifyDomain({
    ...scope,
    domainId: created.id,
    observedChallenge: challenge,
    expectedRevision: 4,
    idempotencyKey: verifyKey,
  });
  const provided = await federation.createProvider({
    ...scope,
    name: 'Provider',
    issuer: 'https://idp.example.test',
    configuration: oidc,
    enabled: true,
    sealSecret: () => ({ ciphertext: 'sealed' }),
    secretFingerprint: 'test-only-fingerprint',
    expectedRevision: 5,
    idempotencyKey: key(),
  });
  const provider = provided.organization?.providers[0];
  if (provider === undefined) throw new Error('Provider missing');
  return {
    owner,
    control,
    linked,
    scope,
    domain,
    domainId: created.id,
    pendingDomainId: pendingDomain.id,
    verifyKey,
    observedChallenge: challenge,
    providerId: provider.id,
    organizationId: made.organization.id,
  };
}
type Organization = Awaited<ReturnType<typeof organization>>;
type Scope = Readonly<{ workspaceId: string; actorId: string }>;

const READS: readonly (readonly [
  string,
  (scope: Scope) => Promise<unknown>,
])[] = [
  ['federation settings', (scope) => federation.settings(scope)],
  ['directory settings', (scope) => directory.settings(scope)],
  ['directory people', (scope) => directory.people(scope, { limit: 10 })],
  [
    'directory adoption',
    (scope) =>
      directory.adoption(scope, {
        directoryUserId: randomUUID(),
        targetWorkspaceId: scope.workspaceId,
      }),
  ],
];

const ownerActions = (f: Organization) =>
  [
    [
      'domain challenge',
      (scope: Scope) =>
        federation.domainChallenge({ ...scope, domainId: f.pendingDomainId }),
    ],
    [
      'verification result',
      (scope: Scope) =>
        federation.verificationResult({
          ...scope,
          domainId: f.domainId,
          expectedRevision: 4,
          idempotencyKey: f.verifyKey,
        }),
    ],
    [
      'provider test',
      (scope: Scope) =>
        signIn.testProvider({
          ...scope,
          providerId: f.providerId,
          domainId: f.domainId,
        }),
    ],
  ] as const;

const commands = (f: Organization) =>
  [
    [
      'add a domain',
      (scope: Scope) =>
        federation.createDomain({
          ...scope,
          domain: `${randomUUID()}.example.test`,
          expectedRevision: 6,
          idempotencyKey: key(),
        }),
    ],
    [
      'issue a directory credential',
      (scope: Scope) =>
        createDirectoryCredential(pool, {
          ...scope,
          name: 'Client',
          expectedRevision: 6,
          idempotencyKey: key(),
        }),
    ],
    [
      'remove a domain',
      (scope: Scope) =>
        federation.removeDomain({
          ...scope,
          domainId: f.domainId,
          expectedRevision: 6,
          idempotencyKey: key(),
        }),
    ],
  ] as const;

type Way = 'builder' | 'operator' | 'viewer';
async function withoutAuthority(f: Organization) {
  const people: (readonly [string, string])[] = [];
  for (const role of [
    'builder',
    'operator',
    'viewer',
  ] as const satisfies Way[]) {
    const person = await db.user(role);
    await db.member(f.control, person.id, role);
    people.push([role, person.id]);
  }
  people.push(['an outsider', (await db.user('Outsider')).id]);
  const suspended = await db.user('Suspended member');
  await db.member(f.control, suspended.id, 'admin');
  await db.asAdmin(
    "update app.workspace_memberships set status='suspended' where user_id=$1",
    [suspended.id],
  );
  people.push(['a suspended admin', suspended.id]);
  const deactivated = await db.user('Deactivated');
  await db.member(f.control, deactivated.id, 'admin');
  await db.asAdmin("update app.users set status='suspended' where id=$1", [
    deactivated.id,
  ]);
  people.push(['a deactivated admin', deactivated.id]);
  return people;
}

async function admin(f: Organization) {
  const person = await db.user('Admin');
  await db.member(f.control, person.id, 'admin');
  return person.id;
}

const setStatus = (workspaceId: string, status: string) =>
  db.asAdmin(
    `update app.workspaces set status=$2::text,
       deletion_requested_at=case when $3 then clock_timestamp() end,
       deletion_requested_by=case when $3 then created_by end,
       deletion_reason=case when $3 then 'state proof' end,
       purge_after=case when $3 then clock_timestamp()+interval '7 days' end
     where id=$1`,
    [
      workspaceId,
      status,
      status === 'pending_deletion' || status === 'purging',
    ],
  );

const outcome = (work: Promise<unknown>) =>
  work.then(
    () => 'answered',
    (error: unknown) =>
      error instanceof WorkspaceAccessDeniedError
        ? 'access denied'
        : ((error as { reason?: string }).reason ?? String(error)),
  );

describe('who can read sign-in and directory settings', () => {
  it('answers an owner and an admin, and denies everyone else', async () => {
    const f = await organization();
    const adminId = await admin(f);
    const denied = await withoutAuthority(f);
    for (const [name, read] of READS) {
      expect(await outcome(read(f.scope)), `${name}: owner`).toBe('answered');
      expect(
        await outcome(read({ workspaceId: f.control, actorId: adminId })),
        `${name}: admin`,
      ).toBe(name === 'directory adoption' ? 'forbidden' : 'answered');
      for (const [who, actorId] of denied)
        expect(
          await outcome(read({ workspaceId: f.control, actorId })),
          `${name}: ${who}`,
        ).toBe('access denied');
    }
  }, 60_000);

  it('lets only the owner manage, and in the directory only from the control workspace', async () => {
    const f = await organization();
    const adminId = await admin(f);
    const asAdmin = { workspaceId: f.control, actorId: adminId };
    const fromLinked = { workspaceId: f.linked, actorId: f.owner.id };
    expect((await federation.settings(f.scope)).canManage).toBe(true);
    expect((await federation.settings(asAdmin)).canManage).toBe(false);
    expect((await federation.settings(fromLinked)).canManage).toBe(false);
    expect((await directory.settings(f.scope)).canManage).toBe(true);
    expect((await directory.settings(asAdmin)).canManage).toBe(false);
    expect((await directory.settings(fromLinked)).canManage).toBe(false);
  }, 60_000);

  it('offers an owner with no organization yet the way to manage', async () => {
    const owner = await db.user('New owner'),
      workspaceId = await db.workspace(owner.id);
    await expect(
      federation.settings({ workspaceId, actorId: owner.id }),
    ).resolves.toMatchObject({ canManage: true, organization: null });
    await expect(
      directory.settings({ workspaceId, actorId: owner.id }),
    ).rejects.toHaveProperty('reason', 'not_found');
  });

  it('lists every linked workspace, read from inside one of them', async () => {
    const f = await organization();
    const settings = await federation.settings({
      workspaceId: f.linked,
      actorId: f.owner.id,
    });
    expect(
      settings.organization?.workspaces
        .map((entry) => entry.workspaceId)
        .sort(),
    ).toEqual([f.control, f.linked].sort());
  }, 60_000);
});

describe('what only an owner can do', () => {
  it('tells an admin an owner is required, and denies anyone below', async () => {
    const f = await organization();
    const adminId = await admin(f);
    const denied = await withoutAuthority(f);
    for (const [name, act] of ownerActions(f)) {
      expect(
        await outcome(act({ workspaceId: f.control, actorId: adminId })),
        `${name}: admin`,
      ).toBe('owner_required');
      for (const [who, actorId] of denied)
        expect(
          await outcome(act({ workspaceId: f.control, actorId })),
          `${name}: ${who}`,
        ).toBe('access denied');
    }
    for (const [name, act] of commands(f)) {
      expect(
        await outcome(act({ workspaceId: f.control, actorId: adminId })),
        `${name}: admin`,
      ).not.toBe('answered');
      for (const [who, actorId] of denied)
        expect(
          await outcome(act({ workspaceId: f.control, actorId })),
          `${name}: ${who}`,
        ).not.toBe('answered');
    }
  }, 60_000);

  it('sends an owner in a linked workspace back to the control workspace', async () => {
    const f = await organization();
    const fromLinked = { workspaceId: f.linked, actorId: f.owner.id };
    const actions = Object.fromEntries(ownerActions(f));
    expect(await outcome(actions['domain challenge'](fromLinked))).toBe(
      'owner_required',
    );
    expect(await outcome(actions['verification result'](fromLinked))).toBe(
      'owner_required',
    );
    expect(await outcome(actions['provider test'](fromLinked))).toBe(
      'unavailable',
    );
  }, 60_000);

  it('answers the owner, or these prove nothing', async () => {
    const f = await organization();
    for (const [name, act] of ownerActions(f))
      expect(await outcome(act(f.scope)), name).toBe('answered');
  }, 60_000);
});

describe('what each workspace state allows', () => {
  it('a suspended workspace still shows its settings, and changes nothing', async () => {
    const f = await organization();
    await setStatus(f.control, 'suspended');
    for (const [name, read] of READS)
      expect(await outcome(read(f.scope)), name).toBe('answered');
    for (const [name, act] of [...ownerActions(f), ...commands(f)])
      expect(await outcome(act(f.scope)), name).not.toBe('answered');
  }, 60_000);

  it('a workspace pending deletion closes all of it to its members', async () => {
    const f = await organization();
    await setStatus(f.control, 'pending_deletion');
    for (const [name, read] of READS)
      expect(await outcome(read(f.scope)), name).toBe('access denied');
    for (const [name, act] of [...ownerActions(f), ...commands(f)])
      expect(await outcome(act(f.scope)), name).not.toBe('answered');
  }, 60_000);

  it.each([
    ['pending_deletion', true],
    ['purging', false],
  ] as const)(
    'sign-in against a %s control workspace answers: %s',
    async (status, open) => {
      const f = await organization();
      const person = await db.user('Signed in');
      await db.asAdmin(
        'update app.auth_domains set require_sso=false where id=$1',
        [f.domainId],
      );
      await db.asAdmin(
        'update app.users set email=$2,email_verified=true where id=$1',
        [person.id, `person@${f.domain}`],
      );
      const state = randomBytes(32),
        browser = randomBytes(32);
      const found = await signIn.provider(f.providerId, f.domain);
      const providerRevision = found?.provider.revision;
      if (providerRevision === undefined) throw new Error('Provider missing');
      await signIn.start({
        id: randomUUID(),
        providerId: f.providerId,
        providerRevision,
        domainId: f.domainId,
        purpose: 'sign_in',
        stateDigest: state,
        browserDigest: browser,
        returnPath: '/workspaces',
      });

      await setStatus(f.control, status);

      // After the change: a lifecycle change ends the sessions it finds.
      const sessionId = randomUUID();
      await db.asAdmin(
        `insert into app.auth_sessions(id,expires_at,token,user_id,authentication_method,federation_provider_id,federation_provider_revision)
         values($1,clock_timestamp()+interval '1 hour',$2,$3,'organization',$4,$5)`,
        [sessionId, randomUUID(), person.id, f.providerId, providerRevision],
      );
      const discovered = await signIn.discover(f.domain);
      const stillFound = await signIn.provider(f.providerId, f.domain);
      const attempt = await signIn.find(state, browser);
      const session = await isAuthenticationSessionAllowed(pool, sessionId);
      const started = await outcome(
        signIn.start({
          id: randomUUID(),
          providerId: f.providerId,
          providerRevision,
          domainId: f.domainId,
          purpose: 'sign_in',
          stateDigest: randomBytes(32),
          browserDigest: randomBytes(32),
          returnPath: '/workspaces',
        }),
      );
      expect({
        discovered: discovered.providers.length > 0,
        found: stillFound !== undefined && stillFound !== null,
        attempt: attempt !== undefined && attempt !== null,
        session,
        started: started === 'answered',
      }).toEqual({
        discovered: open,
        found: open,
        attempt: open,
        session: open,
        started: open,
      });
    },
    60_000,
  );
});

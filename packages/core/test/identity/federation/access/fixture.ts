import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import {
  createFederationManagementStore,
  OrganizationSignInCommands,
} from '../../../../src/identity/index.js';
import { createDirectoryCredential } from '../../../../src/identity/federation/provisioning/management/credentials.repository.js';
import { createDirectoryStore } from '../../../../src/identity/federation/provisioning/store.js';
import { WorkspaceAccessDeniedError } from '../../../../src/tenant-access/errors.js';
import { useIdentityCommandDatabase } from '../../command.support.js';

export const db = useIdentityCommandDatabase('identity_access');

export let pool: Pool;
export let federation: ReturnType<typeof createFederationManagementStore>;
export let directory: ReturnType<typeof createDirectoryStore>;
export let signIn: OrganizationSignInCommands;

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
export async function organization() {
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
export type Organization = Awaited<ReturnType<typeof organization>>;
export type Scope = Readonly<{ workspaceId: string; actorId: string }>;

export const READS: readonly (readonly [
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

export const ownerActions = (f: Organization) =>
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

export const commands = (f: Organization) =>
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
export async function withoutAuthority(f: Organization) {
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

export async function admin(f: Organization) {
  const person = await db.user('Admin');
  await db.member(f.control, person.id, 'admin');
  return person.id;
}

export const setStatus = (workspaceId: string, status: string) =>
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

export const outcome = (work: Promise<unknown>) =>
  work.then(
    () => 'answered',
    (error: unknown) =>
      error instanceof WorkspaceAccessDeniedError
        ? 'access denied'
        : ((error as { reason?: string }).reason ?? String(error)),
  );

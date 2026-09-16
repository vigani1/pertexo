import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  createOidcLoginTransactionStore,
  IdentityConflictError,
  IdempotencyRequestConflictError,
  IdentityNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspaceMemberRoleCommandConflictError,
  OidcTransactionCapacityError,
  OidcTransactionSealingError,
  parseDatabaseConfig,
  auditEvents,
  workspaceMemberships,
} from '../src/testing.js';
import { migrateDatabase } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const databaseName = `pertexo_test_identity_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_api', 'pertexo_worker'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = fixture.databaseUrl(migrationBaseUrl);
const apiUrl = fixture.databaseUrl(apiBaseUrl);
const workerUrl = fixture.databaseUrl(workerBaseUrl);

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

let identityDatabase: ReturnType<typeof createIdentityWorkspaceDatabase>;
let tenantDatabase: ReturnType<typeof createWorkspaceDatabase>;
let oidcStore: ReturnType<typeof createOidcLoginTransactionStore>;
const identityResources: { close(): Promise<void> }[] = [];
let ownerUserId: string;
let workspaceId: string;
let ownerSessionId: string;

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as DatabaseError).code;
    if (code !== undefined) return code;
    current = current.cause;
  }
  return undefined;
}

async function replaceOidcTransactions(input: {
  active?: number;
  consumed?: number;
  stale?: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query(
        'alter table app.oidc_login_transactions disable trigger oidc_login_transactions_capacity',
      );
      await client.query('delete from app.oidc_login_transactions');
      const variants = [
        {
          count: input.active ?? 0,
          prefix: `active-${randomUUID()}`,
          createdAt: "clock_timestamp() - interval '1 minute'",
          expiresAt: "clock_timestamp() + interval '1 hour'",
          consumedAt: 'null',
        },
        {
          count: input.consumed ?? 0,
          prefix: `consumed-${randomUUID()}`,
          createdAt: "clock_timestamp() - interval '2 minutes'",
          expiresAt: "clock_timestamp() + interval '1 hour'",
          consumedAt: "clock_timestamp() - interval '1 minute'",
        },
        {
          count: input.stale ?? 0,
          prefix: `stale-${randomUUID()}`,
          createdAt: "clock_timestamp() - interval '2 hours'",
          expiresAt: "clock_timestamp() - interval '1 hour'",
          consumedAt: 'null',
        },
      ];
      for (const variant of variants) {
        if (variant.count === 0) continue;
        await client.query(
          `insert into app.oidc_login_transactions
             (state_digest, code_verifier_ciphertext, code_verifier_nonce,
              code_verifier_tag, code_verifier_key_version, nonce_ciphertext,
              nonce_nonce, nonce_tag, nonce_key_version, expires_at, consumed_at,
              created_at, browser_binding_digest)
           select md5($1 || series::text) || md5(series::text || $1),
                  'sealed-verifier', 'nonce', 'tag', 'test-v1',
                  'sealed-nonce', 'nonce', 'tag', 'test-v1',
                  ${variant.expiresAt}, ${variant.consumedAt}, ${variant.createdAt},
                  repeat('0', 64)
           from generate_series(1, $2::integer) as series`,
          [variant.prefix, variant.count],
        );
      }
      await client.query(
        'alter table app.oidc_login_transactions enable trigger oidc_login_transactions_capacity',
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function clearOidcTransactions(): Promise<void> {
  await replaceOidcTransactions({});
}

function oidcTransaction() {
  return {
    stateDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    browserBindingDigest: createHash('sha256')
      .update(randomUUID())
      .digest('hex'),
    codeVerifier: `verifier-${randomUUID()}`,
    nonce: `nonce-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase(migrationConfig);
  identityDatabase = createIdentityWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
  );
  identityResources.push(identityDatabase);
  tenantDatabase = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
  );
  identityResources.push(tenantDatabase);
  oidcStore = createOidcLoginTransactionStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    {
      seal: (plaintext, associatedData) => ({
        ciphertext: Buffer.from(
          `${associatedData}:${plaintext}`,
          'utf8',
        ).toString('base64url'),
        nonce: 'test-nonce',
        tag: 'test-tag',
        keyVersion: 'test-v1',
      }),
      open: (sealed, associatedData) => {
        const decoded = Buffer.from(sealed.ciphertext, 'base64url').toString(
          'utf8',
        );
        const prefix = `${associatedData}:`;
        if (!decoded.startsWith(prefix))
          throw new Error('associated data mismatch');
        return decoded.slice(prefix.length);
      },
    },
  );
  identityResources.push(oidcStore);
  const user = await identityDatabase.createUser({
    email: `${randomUUID()}@example.test`,
    displayName: 'Phase One Owner',
  });
  ownerUserId = user.id;
  await identityDatabase.linkAuthIdentity({
    userId: ownerUserId,
    issuer: 'https://issuer.example.test',
    providerSubject: randomUUID(),
  });
  const session = await identityDatabase.createSession({
    userId: ownerUserId,
    tokenDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000),
  });
  ownerSessionId = session.id;
  const workspace = await identityDatabase.createWorkspaceWithOwner({
    name: 'Identity Workspace',
    slug: `identity-${randomUUID().slice(0, 12)}`,
    ownerUserId,
    requestId: 'request-phase1',
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  const closeResults = await Promise.allSettled(
    identityResources.map((resource) => resource.close()),
  );
  const failures = closeResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  try {
    await fixture.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Identity fixture cleanup failed');
});

describe('identity/workspace persistence', () => {
  it('discovers only the actor active workspaces with stable keyset pagination', async () => {
    const second = await identityDatabase.createWorkspaceWithOwner({
      name: 'Second Accessible Workspace',
      slug: `second-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const outsider = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Workspace Outsider',
    });
    const hidden = await identityDatabase.createWorkspaceWithOwner({
      name: 'Hidden Workspace',
      slug: `hidden-${randomUUID().slice(0, 12)}`,
      ownerUserId: outsider.id,
    });

    const discovered: string[] = [];
    let after: string | undefined;
    do {
      const page = await identityDatabase.listAccessibleWorkspaces(
        ownerUserId,
        { limit: 1, ...(after === undefined ? {} : { after }) },
      );
      discovered.push(...page.items.map((workspace) => workspace.id));
      for (const accessibleWorkspace of page.items) {
        expect(accessibleWorkspace).toMatchObject({
          role: 'owner',
          status: 'active',
        });
      }
      after = page.nextCursor;
    } while (after !== undefined);

    expect(discovered).toContain(workspaceId);
    expect(discovered).toContain(second.id);
    expect(discovered).not.toContain(hidden.id);
    expect(discovered).toEqual([...discovered].sort());

    const outsiderPage = await identityDatabase.listAccessibleWorkspaces(
      outsider.id,
    );
    expect(outsiderPage.items.map((workspace) => workspace.id)).toEqual([
      hidden.id,
    ]);
  });

  it('does not apply actor discovery inside an ordinary workspace transaction', async () => {
    const second = await identityDatabase.createWorkspaceWithOwner({
      name: 'Same actor isolated workspace',
      slug: `same-actor-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.workspace_id', $1, true),
                  set_config('app.actor_id', $2, true)`,
          [workspaceId, ownerUserId],
        );
        const rows = await client.query<{ workspace_id: string }>(
          'select workspace_id from app.workspace_memberships order by workspace_id',
        );
        expect(rows.rows.map((row) => row.workspace_id)).toEqual([workspaceId]);
        expect(rows.rows.map((row) => row.workspace_id)).not.toContain(
          second.id,
        );
        await client.query('commit');
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('links identities idempotently and only resolves live session digests', async () => {
    const liveDigest = createHash('sha256').update(randomUUID()).digest('hex');
    const live = await identityDatabase.createSession({
      userId: ownerUserId,
      tokenDigest: liveDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      (await identityDatabase.findActiveSessionByDigest(liveDigest))?.id,
    ).toBe(live.id);
    const session = await identityDatabase.findActiveSessionByDigest(
      createHash('sha256').update('missing').digest('hex'),
    );
    expect(session).toBeNull();
    expect(await identityDatabase.revokeSession(ownerSessionId)).toBe(true);
    expect(await identityDatabase.revokeSession(ownerSessionId)).toBe(false);
  });

  it.each(['suspended', 'deleted'] as const)(
    'fails closed across identity, session, and workspace access when a user is %s',
    async (status) => {
      const issuer = `https://issuer-${randomUUID()}.example.test`;
      const providerSubject = randomUUID();
      const resolved = await identityDatabase.resolveOrCreateIdentity({
        issuer,
        providerSubject,
        email: `${randomUUID()}@example.test`,
        displayName: 'Status controlled user',
      });
      const sessionDigest = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      await identityDatabase.createSession({
        userId: resolved.user.id,
        tokenDigest: sessionDigest,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const workspace = await identityDatabase.createWorkspaceWithOwner({
        name: 'Status controlled workspace',
        slug: `status-${randomUUID().slice(0, 12)}`,
        ownerUserId: resolved.user.id,
      });

      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await owner.query('set role pertexo_owner');
        await owner.query('update app.users set status = $2 where id = $1', [
          resolved.user.id,
          status,
        ]);
      } finally {
        await owner.end();
      }

      await expect(
        identityDatabase.resolveOrCreateIdentity({
          issuer,
          providerSubject,
          email: resolved.user.email,
          displayName: resolved.user.displayName,
        }),
      ).rejects.toBeInstanceOf(IdentityNotFoundError);
      await expect(
        identityDatabase.createSession({
          userId: resolved.user.id,
          tokenDigest: createHash('sha256').update(randomUUID()).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeInstanceOf(IdentityNotFoundError);
      await expect(
        identityDatabase.findActiveSessionByDigest(sessionDigest),
      ).resolves.toBeNull();
      await expect(
        identityDatabase.findWorkspaceAccess(resolved.user.id, workspace.id),
      ).resolves.toBeNull();
    },
  );

  it('revokes a session by digest atomically with one concurrent winner', async () => {
    const tokenDigest = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.createSession({
      userId: ownerUserId,
      tokenDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const outcomes = await Promise.all([
      identityDatabase.revokeSessionByDigest(tokenDigest),
      identityDatabase.revokeSessionByDigest(tokenDigest),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    await expect(
      identityDatabase.revokeSessionByDigest(tokenDigest),
    ).resolves.toBe(false);
    await expect(
      identityDatabase.revokeSessionByDigest('not-a-sha256-digest'),
    ).rejects.toThrow();
  });

  it('cancels a session lookup blocked inside PostgreSQL and replaces its client', async () => {
    const blockerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const observerPool = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    let blocker: PoolClient | undefined;
    const controller = new AbortController();
    const digest = createHash('sha256').update(randomUUID()).digest('hex');
    let lookup: Promise<unknown> | undefined;
    try {
      blocker = await blockerPool.connect();
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query('lock table app.sessions in access exclusive mode');
      lookup = identityDatabase.findActiveSessionByDigest(digest, {
        signal: controller.signal,
      });
      void lookup.catch(() => undefined);
      await expect
        .poll(
          async () => {
            const result = await observerPool.query<{ blocked: boolean }>(
              `select exists(
                 select 1 from pg_stat_activity
                 where datname = current_database()
                   and usename = $1
                   and wait_event_type = 'Lock'
                   and query like '%from app.sessions s%'
               ) as blocked`,
              [new URL(apiUrl).username],
            );
            return result.rows[0]?.blocked;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      controller.abort();
      await expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      controller.abort();
      await blocker?.query('rollback').catch(() => undefined);
      blocker?.release();
      await Promise.all([blockerPool.end(), observerPool.end()]);
    }
    await expect(
      identityDatabase.findActiveSessionByDigest(digest),
    ).resolves.toBeNull();
  }, 15_000);

  it('creates owner membership and audit atomically under workspace RLS', async () => {
    const rows = await tenantDatabase.withWorkspace(
      workspaceId,
      async ({ db }) => {
        const memberships = await db.select().from(workspaceMemberships);
        const events = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, workspaceId));
        return { memberships, events };
      },
    );
    expect(rows.memberships).toHaveLength(1);
    expect(rows.memberships[0]?.role).toBe('owner');
    expect(rows.events).toHaveLength(1);
    expect(rows.events[0]?.action).toBe('workspace.created');
  });

  it('returns only the exact actor/workspace authorization row', async () => {
    await expect(
      identityDatabase.findWorkspaceAccess(ownerUserId, workspaceId),
    ).resolves.toEqual({
      actorId: ownerUserId,
      workspaceId,
      role: 'owner',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    });
    await expect(
      identityDatabase.findWorkspaceAccess(randomUUID(), workspaceId),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.findWorkspaceAccess(ownerUserId, randomUUID()),
    ).resolves.toBeNull();
  });

  it('lists active workspace members with bounded tuple pagination and rechecks member-read authorization', async () => {
    const isolatedWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Member pagination',
      slug: `members-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const members = await Promise.all(
      ['Active A', 'Suspended membership', 'Removed', 'Inactive user'].map(
        (displayName) =>
          identityDatabase.createUser({
            email: `${randomUUID()}@example.test`,
            displayName,
          }),
      ),
    );
    const [active, suspended, removed, inactive] = members;
    if (
      active === undefined ||
      suspended === undefined ||
      removed === undefined ||
      inactive === undefined
    )
      throw new Error('Member fixtures were not created');
    await tenantDatabase.withWorkspace(isolatedWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values([
        {
          workspaceId: isolatedWorkspace.id,
          userId: active.id,
          role: 'viewer',
          status: 'active',
        },
        {
          workspaceId: isolatedWorkspace.id,
          userId: suspended.id,
          role: 'viewer',
          status: 'suspended',
        },
        {
          workspaceId: isolatedWorkspace.id,
          userId: removed.id,
          role: 'viewer',
          status: 'removed',
        },
        {
          workspaceId: isolatedWorkspace.id,
          userId: inactive.id,
          role: 'viewer',
          status: 'active',
        },
      ]);
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        `update app.workspace_memberships
         set created_at = case
           when user_id = $2 then '2026-09-13 12:00:00.123455+00'::timestamptz
           when user_id in ($3, $4) then '2026-09-13 12:00:00.123456+00'::timestamptz
           else '2026-09-13 12:00:00.123457+00'::timestamptz
         end
         where workspace_id = $1`,
        [isolatedWorkspace.id, ownerUserId, active.id, suspended.id],
      );
      await owner.query(
        `update app.users set status = 'suspended' where id = $1`,
        [inactive.id],
      );
    } finally {
      await owner.end();
    }

    const traversed: { userId: string; membershipStatus: string }[] = [];
    let cursor: Readonly<{ createdAt: string; userId: string }> | undefined;
    do {
      const page = await identityDatabase.listWorkspaceMembers(
        isolatedWorkspace.id,
        ownerUserId,
        { limit: 1, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      traversed.push(...page.items);
      if (page.nextCursor !== undefined)
        expect(page.nextCursor.createdAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u,
        );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const tied = [active.id, suspended.id].sort();
    expect(traversed).toEqual([
      expect.objectContaining({
        userId: ownerUserId,
        membershipStatus: 'active',
      }),
      expect.objectContaining({
        userId: tied[0],
        membershipStatus: tied[0] === active.id ? 'active' : 'suspended',
      }),
      expect.objectContaining({
        userId: tied[1],
        membershipStatus: tied[1] === active.id ? 'active' : 'suspended',
      }),
    ]);
    expect(traversed.map((member) => member.userId)).not.toContain(removed.id);
    expect(traversed.map((member) => member.userId)).not.toContain(inactive.id);

    await tenantDatabase.withWorkspace(isolatedWorkspace.id, async ({ db }) => {
      await db
        .update(workspaceMemberships)
        .set({ role: 'viewer' })
        .where(eq(workspaceMemberships.userId, ownerUserId));
    });
    try {
      await expect(
        identityDatabase.listWorkspaceMembers(
          isolatedWorkspace.id,
          ownerUserId,
        ),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    } finally {
      await tenantDatabase.withWorkspace(
        isolatedWorkspace.id,
        async ({ db }) => {
          await db
            .update(workspaceMemberships)
            .set({ role: 'owner' })
            .where(eq(workspaceMemberships.userId, ownerUserId));
        },
      );
    }
  });

  it.each([
    '2026-99-99T99:99:99.000000Z',
    '2026-02-30T12:00:00.000000Z',
    '0000-01-01T00:00:00.000000Z',
  ])(
    'rejects malformed member cursor timestamp %s before SQL',
    async (createdAt) => {
      await expect(
        identityDatabase.listWorkspaceMembers(workspaceId, ownerUserId, {
          after: { createdAt, userId: ownerUserId },
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
    },
  );

  it('changes an existing member role once, revokes sessions, and replays without reapplying', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role command',
      slug: `role-command-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Role target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const targetSession = await identityDatabase.createSession({
      userId: target.id,
      tokenDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const original = {
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: 'builder' as const,
      expectedRoleRevision: 1,
      idempotencyKey: `role-${randomUUID()}`,
      requestId: 'role-request',
      traceId: 'role-trace',
    };
    await expect(
      identityDatabase.changeWorkspaceMemberRole(original),
    ).resolves.toEqual({
      userId: target.id,
      role: 'builder',
      roleRevision: 2,
      changed: true,
      replayed: false,
    });
    await expect(
      identityDatabase.findActiveSessionByDigest(targetSession.tokenDigest),
    ).resolves.toBeNull();

    await identityDatabase.changeWorkspaceMemberRole({
      ...original,
      role: 'operator',
      expectedRoleRevision: 2,
      idempotencyKey: `role-${randomUUID()}`,
    });
    await expect(
      identityDatabase.changeWorkspaceMemberRole(original),
    ).resolves.toMatchObject({
      role: 'builder',
      roleRevision: 2,
      replayed: true,
    });
    const noOpDigest = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.createSession({
      userId: target.id,
      tokenDigest: noOpDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const noOpKey = `role-${randomUUID()}`;
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        ...original,
        role: 'operator',
        expectedRoleRevision: 3,
        idempotencyKey: noOpKey,
      }),
    ).resolves.toMatchObject({
      role: 'operator',
      roleRevision: 3,
      changed: false,
      replayed: false,
    });
    await expect(
      identityDatabase.findActiveSessionByDigest(noOpDigest),
    ).resolves.toMatchObject({ userId: target.id });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        ...original,
        role: 'viewer',
        expectedRoleRevision: 3,
        idempotencyKey: noOpKey,
      }),
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' });
    const rows = await identityDatabase.listWorkspaceMembers(
      commandWorkspace.id,
      ownerUserId,
    );
    expect(
      rows.items.find((member) => member.userId === target.id),
    ).toMatchObject({
      role: 'operator',
      roleRevision: 3,
    });
    const facts = await tenantDatabase.withWorkspace(
      commandWorkspace.id,
      async ({ db }) =>
        db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, commandWorkspace.id)),
    );
    expect(
      facts.filter((event) => event.action === 'workspace.member_role_changed'),
    ).toHaveLength(2);
  });

  it('serializes same-revision role changes and rejects stale and forbidden transitions', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role concurrency',
      slug: `role-concurrency-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const [target, admin] = await Promise.all([
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Target',
      }),
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Admin',
      }),
    ]);
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values([
        {
          workspaceId: commandWorkspace.id,
          userId: target.id,
          role: 'viewer',
          status: 'active',
        },
        {
          workspaceId: commandWorkspace.id,
          userId: admin.id,
          role: 'admin',
          status: 'active',
        },
      ]);
    });
    const results = await Promise.allSettled([
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'operator',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status !== 'rejected')
      throw new Error('A concurrent role command should have failed');
    expect(
      (rejected.reason as WorkspaceMemberRoleCommandConflictError).reason,
    ).toBe('revision_conflict');
    const afterConcurrent = (
      await identityDatabase.listWorkspaceMembers(
        commandWorkspace.id,
        ownerUserId,
      )
    ).items.find((member) => member.userId === target.id);
    if (afterConcurrent === undefined)
      throw new Error('Concurrent target member is unavailable');
    if (afterConcurrent.role === 'owner')
      throw new Error('Concurrent target unexpectedly became owner');
    const alternateRole =
      afterConcurrent.role === 'builder' ? 'operator' : 'builder';
    await identityDatabase.changeWorkspaceMemberRole({
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: alternateRole,
      expectedRoleRevision: afterConcurrent.roleRevision,
      idempotencyKey: randomUUID(),
    });
    await identityDatabase.changeWorkspaceMemberRole({
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: afterConcurrent.role,
      expectedRoleRevision: afterConcurrent.roleRevision + 1,
      idempotencyKey: randomUUID(),
    });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: alternateRole,
        expectedRoleRevision: afterConcurrent.roleRevision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'revision_conflict' });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: randomUUID(),
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'target_missing' });
    for (const status of ['suspended', 'removed'] as const) {
      await tenantDatabase.withWorkspace(
        commandWorkspace.id,
        async ({ db }) => {
          await db
            .update(workspaceMemberships)
            .set({ status })
            .where(eq(workspaceMemberships.userId, target.id));
        },
      );
      await expect(
        identityDatabase.changeWorkspaceMemberRole({
          workspaceId: commandWorkspace.id,
          actorUserId: ownerUserId,
          targetUserId: target.id,
          role: alternateRole,
          expectedRoleRevision: afterConcurrent.roleRevision + 2,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'target_inactive' });
    }
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db
        .update(workspaceMemberships)
        .set({ status: 'active' })
        .where(eq(workspaceMemberships.userId, target.id));
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(`update app.users set status='suspended' where id=$1`, [
        target.id,
      ]);
      await expect(
        identityDatabase.changeWorkspaceMemberRole({
          workspaceId: commandWorkspace.id,
          actorUserId: ownerUserId,
          targetUserId: target.id,
          role: alternateRole,
          expectedRoleRevision: afterConcurrent.roleRevision + 2,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'target_inactive' });
    } finally {
      await owner.end();
    }
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: admin.id,
        targetUserId: ownerUserId,
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'owner_change' });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: admin.id,
        targetUserId: admin.id,
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkspaceMemberRoleCommandConflictError);
  });

  it('rolls back role, session, audit, and receipt writes when a late audit insert fails', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role rollback',
      slug: `role-rollback-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Rollback target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const digest = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.createSession({
      userId: target.id,
      tokenDigest: digest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const idempotencyKey = randomUUID();
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey,
        requestId: 'x'.repeat(129),
      }),
    ).rejects.toBeDefined();
    const unchanged = await identityDatabase.listWorkspaceMembers(
      commandWorkspace.id,
      ownerUserId,
    );
    expect(
      unchanged.items.find((member) => member.userId === target.id),
    ).toMatchObject({
      role: 'viewer',
      roleRevision: 1,
    });
    await expect(
      identityDatabase.findActiveSessionByDigest(digest),
    ).resolves.toMatchObject({ userId: target.id });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ changed: true, replayed: false });
  });

  it('coalesces concurrent duplicate role commands into one durable side effect', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role duplicate',
      slug: `role-duplicate-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Duplicate target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const command = {
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: 'operator' as const,
      expectedRoleRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const receipts = await Promise.all([
      identityDatabase.changeWorkspaceMemberRole(command),
      identityDatabase.changeWorkspaceMemberRole(command),
    ]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const facts = await tenantDatabase.withWorkspace(
      commandWorkspace.id,
      async ({ db }) =>
        db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, commandWorkspace.id)),
    );
    expect(
      facts.filter((event) => event.action === 'workspace.member_role_changed'),
    ).toHaveLength(1);
  });

  it('serializes a manager demotion ahead of the manager’s queued command', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Manager demotion',
      slug: `manager-demotion-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const [manager, target] = await Promise.all([
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Manager',
      }),
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Managed target',
      }),
    ]);
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values([
        {
          workspaceId: commandWorkspace.id,
          userId: manager.id,
          role: 'admin',
          status: 'active',
        },
        {
          workspaceId: commandWorkspace.id,
          userId: target.id,
          role: 'viewer',
          status: 'active',
        },
      ]);
    });
    const blockerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const blocker = await blockerPool.connect();
    let demotion: Promise<unknown> | undefined;
    let staleManagerCommand: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query(
        'select id from app.workspaces where id=$1 for update',
        [commandWorkspace.id],
      );
      demotion = identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: manager.id,
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      void demotion.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      staleManagerCommand = identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: manager.id,
        targetUserId: target.id,
        role: 'operator',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      void staleManagerCommand.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await blocker.query('commit');
      await expect(demotion).resolves.toMatchObject({ role: 'viewer' });
      await expect(staleManagerCommand).rejects.toMatchObject({
        reason: 'actor_inactive',
      });
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await blockerPool.end();
    }
  }, 15_000);

  it('serializes role mutation with the workspace lifecycle command lock', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role lifecycle lock',
      slug: `role-lifecycle-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Lifecycle target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const blockerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const blocker = await blockerPool.connect();
    let lifecycle: Promise<unknown> | undefined;
    let roleChange: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query(
        'select id from app.workspaces where id=$1 for update',
        [commandWorkspace.id],
      );
      lifecycle = identityDatabase.requestWorkspaceLifecycleOperation({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        commandType: 'deletion_requested',
        reason: 'Concurrency proof',
        idempotencyKey: randomUUID(),
      });
      void lifecycle.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      roleChange = identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      void roleChange.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await blocker.query('commit');
      await expect(lifecycle).resolves.toMatchObject({
        commandType: 'deletion_requested',
      });
      await expect(roleChange).resolves.toMatchObject({
        role: 'builder',
        roleRevision: 2,
      });
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await blockerPool.end();
    }
  }, 15_000);

  it('provides a valid ordered index for non-removed member discovery', async () => {
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const result = await pool.query<{
        valid: boolean;
        definition: string;
        predicate: string;
      }>(
        `select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition,
                pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_index i
         where i.indexrelid = 'app.workspace_memberships_workspace_created_idx'::regclass`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.valid).toBe(true);
      expect(result.rows[0]?.definition).toContain(
        '(workspace_id, created_at, user_id)',
      );
      expect(result.rows[0]?.predicate).toContain('active');
      expect(result.rows[0]?.predicate).toContain('suspended');
      expect(result.rows[0]?.predicate).not.toContain('removed');
    } finally {
      await pool.end();
    }
  });

  it('keeps worker identity access least-privilege while allowing workspace status reads', async () => {
    const catalog = new Pool({ connectionString: migrationUrl, max: 1 });
    const catalogClient = await catalog.connect();
    try {
      await catalogClient.query('begin');
      await catalogClient.query('set local role pertexo_owner');
      const privileges = await catalogClient.query<{
        authIdentities: boolean;
        sessions: boolean;
        users: boolean;
        workspaceId: boolean;
        workspaceName: boolean;
        workspaceStatus: boolean;
      }>(`
        select
          has_table_privilege('pertexo_worker', 'app.users', 'SELECT') as "users",
          has_table_privilege('pertexo_worker', 'app.auth_identities', 'SELECT') as "authIdentities",
          has_table_privilege('pertexo_worker', 'app.sessions', 'SELECT') as "sessions",
          has_column_privilege('pertexo_worker', 'app.workspaces', 'id', 'SELECT') as "workspaceId",
          has_column_privilege('pertexo_worker', 'app.workspaces', 'status', 'SELECT') as "workspaceStatus",
          has_column_privilege('pertexo_worker', 'app.workspaces', 'name', 'SELECT') as "workspaceName"
      `);
      expect(privileges.rows[0]).toEqual({
        users: false,
        authIdentities: false,
        sessions: false,
        workspaceId: true,
        workspaceStatus: true,
        workspaceName: false,
      });
      await catalogClient.query('commit');
    } catch (error: unknown) {
      await catalogClient.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      catalogClient.release();
      await catalog.end();
    }

    const worker = new Pool({ connectionString: workerUrl, max: 1 });
    try {
      await expect(
        worker.query('select id, status from app.workspaces'),
      ).resolves.toBeTruthy();
      for (const statement of [
        'select email from app.users',
        'select issuer from app.auth_identities',
        'select token_digest from app.sessions',
        'select name from app.workspaces',
        'select workspace_id from app.workspace_memberships',
        'select workspace_id from app.audit_events',
      ]) {
        await expect(worker.query(statement)).rejects.toSatisfy(
          (error: unknown) => {
            let current: unknown = error;
            while (current instanceof Error) {
              if ((current as { code?: string }).code === '42501') return true;
              current = current.cause;
            }
            return false;
          },
        );
      }
    } finally {
      await worker.end();
    }
  });

  it('fails closed without context and prevents cross-workspace reads', async () => {
    const secondUser = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Second Owner',
    });
    const second = await identityDatabase.createWorkspaceWithOwner({
      name: 'Second Workspace',
      slug: `second-${randomUUID().slice(0, 12)}`,
      ownerUserId: secondUser.id,
    });
    const crossRead = await tenantDatabase.withWorkspace(
      workspaceId,
      async ({ db }) => {
        const memberships = await db
          .select()
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, second.id));
        const events = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, second.id));
        return { memberships, events };
      },
    );
    expect(crossRead.memberships).toEqual([]);
    expect(crossRead.events).toEqual([]);

    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const result = await pool.query('select * from app.audit_events');
      expect(result.rows).toEqual([]);
      const memberships = await pool.query(
        'select * from app.workspace_memberships',
      );
      expect(memberships.rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('accepts and reads one exact lifecycle operation without projecting workspace state', async () => {
    const workspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Asynchronous lifecycle workspace',
      slug: `lifecycle-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const deletionKey = `delete-${randomUUID()}`;
    const deletionCommand = () =>
      identityDatabase.requestWorkspaceLifecycleOperation({
        workspaceId: workspace.id,
        actorUserId: ownerUserId,
        commandType: 'deletion_requested',
        reason: 'idempotent deletion',
        idempotencyKey: deletionKey,
      });
    const [deletedLeft, deletedRight] = await Promise.all([
      deletionCommand(),
      deletionCommand(),
    ]);
    expect(deletedRight).toEqual(deletedLeft);
    expect(deletedLeft).toMatchObject({
      workspaceId: workspace.id,
      commandType: 'deletion_requested',
      status: 'pending',
      completedAt: null,
      errorCode: null,
    });
    await expect(
      identityDatabase.readWorkspaceLifecycleOperation(
        workspace.id,
        deletedLeft.id,
        ownerUserId,
      ),
    ).resolves.toEqual(deletedLeft);
    await expect(
      identityDatabase.findWorkspaceAccess(ownerUserId, workspace.id),
    ).resolves.toMatchObject({ workspaceStatus: 'active' });
    await expect(
      identityDatabase.requestWorkspaceLifecycleOperation({
        workspaceId: workspace.id,
        actorUserId: ownerUserId,
        commandType: 'deletion_requested',
        reason: 'changed deletion request',
        idempotencyKey: deletionKey,
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    await expect(
      identityDatabase.readWorkspaceLifecycleOperation(
        workspace.id,
        randomUUID(),
        ownerUserId,
      ),
    ).resolves.toBeNull();
  });

  it('denies direct lifecycle projection to the API credential', async () => {
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query(
          `update app.workspaces set status='pending_deletion',
             deletion_requested_at=clock_timestamp(),deletion_requested_by=$2,
             deletion_reason='direct projection is forbidden',
             purge_after=clock_timestamp()+interval '30 days'
           where id=$1`,
          [workspaceId, ownerUserId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });

  it('denies audit updates and deletes to the API runtime role', async () => {
    await expect(
      tenantDatabase.withWorkspace(workspaceId, async ({ db }) =>
        db
          .update(auditEvents)
          .set({ action: 'tampered' })
          .where(eq(auditEvents.workspaceId, workspaceId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      tenantDatabase.withWorkspace(workspaceId, async ({ db }) =>
        db.delete(auditEvents).where(eq(auditEvents.workspaceId, workspaceId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });

  it('serializes duplicate workspace slugs and leaves one complete aggregate', async () => {
    const slug = `concurrent-${randomUUID().slice(0, 12)}`;
    const outcomes = await Promise.allSettled([
      identityDatabase.createWorkspaceWithOwner({
        name: 'Concurrent A',
        slug,
        ownerUserId,
      }),
      identityDatabase.createWorkspaceWithOwner({
        name: 'Concurrent B',
        slug,
        ownerUserId,
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toBeDefined();
    if (rejected?.status !== 'rejected') {
      throw new Error('Expected one workspace slug conflict');
    }
    expect(rejected.reason).toBeInstanceOf(IdentityConflictError);
    expect(rejected.reason).toMatchObject({ reason: 'workspace_slug' });
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const result = await pool.query<{ id: string }>(
        `select w.id from app.workspaces w where w.slug = $1`,
        [slug],
      );
      expect(result.rows).toHaveLength(1);
      const aggregateId = result.rows[0]?.id;
      if (aggregateId === undefined)
        throw new Error('Concurrent workspace was not returned');
      const aggregate = await tenantDatabase.withWorkspace(
        aggregateId,
        async ({ db }) => ({
          members: await db.select().from(workspaceMemberships),
          events: await db.select().from(auditEvents),
        }),
      );
      expect(aggregate.members).toHaveLength(1);
      expect(aggregate.events).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('returns one durable workspace creation for concurrent exact idempotency retries and conflicts on changed input', async () => {
    const slug = `idempotent-${randomUUID().slice(0, 12)}`;
    const idempotencyKey = `create-${randomUUID()}`;
    const command = {
      name: 'Idempotent workspace',
      slug,
      ownerUserId,
      idempotencyKey,
    } as const;

    const [left, right] = await Promise.all([
      identityDatabase.createWorkspaceWithOwner(command),
      identityDatabase.createWorkspaceWithOwner(command),
    ]);

    expect(right).toEqual(left);
    await expect(
      identityDatabase.createWorkspaceWithOwner({
        ...command,
        name: 'Changed workspace request',
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    const aggregate = await tenantDatabase.withWorkspace(
      left.id,
      async ({ db }) => ({
        memberships: await db.select().from(workspaceMemberships),
        events: await db.select().from(auditEvents),
      }),
    );
    expect(aggregate.memberships).toHaveLength(1);
    expect(aggregate.events).toHaveLength(1);
  });

  it('resolves one exact issuer/subject identity under concurrent first login', async () => {
    const issuer = `https://issuer-${randomUUID()}.example.test`;
    const subject = randomUUID();
    const results = await Promise.all([
      identityDatabase.resolveOrCreateIdentity({
        issuer,
        providerSubject: subject,
        email: `${randomUUID()}@example.test`,
        displayName: 'First profile',
      }),
      identityDatabase.resolveOrCreateIdentity({
        issuer,
        providerSubject: subject,
        email: `${randomUUID()}@example.test`,
        displayName: 'Second profile',
      }),
    ]);
    const first = results[0];
    const second = results[1];
    expect(first.user.id).toBe(second.user.id);
    expect(first.identity.id).toBe(second.identity.id);

    const sameEmail = `${randomUUID()}@example.test`;
    const separateA = await identityDatabase.resolveOrCreateIdentity({
      issuer: `https://issuer-a-${randomUUID()}.example.test`,
      providerSubject: randomUUID(),
      email: sameEmail,
      displayName: 'Profile A',
    });
    await expect(
      identityDatabase.resolveOrCreateIdentity({
        issuer: `https://issuer-b-${randomUUID()}.example.test`,
        providerSubject: randomUUID(),
        email: sameEmail,
        displayName: 'Profile B',
      }),
    ).rejects.toBeInstanceOf(IdentityConflictError);
    const emailPool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const persisted = await emailPool.query<{
        identities: string;
        sessions: string;
        users: string;
      }>(
        `select
           count(distinct u.id)::text as users,
           count(distinct i.id)::text as identities,
           count(distinct s.id)::text as sessions
         from app.users u
         left join app.auth_identities i on i.user_id = u.id
         left join app.sessions s on s.user_id = u.id
         where lower(u.email) = lower($1)`,
        [sameEmail],
      );
      expect(separateA.user.id).toBeTruthy();
      expect(persisted.rows[0]).toEqual({
        users: '1',
        identities: '1',
        sessions: '0',
      });
    } finally {
      await emailPool.end();
    }
  });

  it('rejects credential-shaped audit metadata before persistence', async () => {
    await expect(
      identityDatabase.createWorkspaceWithOwner({
        name: 'Unsafe metadata',
        slug: `unsafe-${randomUUID().slice(0, 12)}`,
        ownerUserId,
        metadata: { token: 'must-not-persist' },
      }),
    ).rejects.toThrow('Unsafe audit metadata key');
  });

  it('seals OIDC verifier and nonce, consumes once, and classifies expiry/replay atomically', async () => {
    const stateDigest = createHash('sha256').update(randomUUID()).digest('hex');
    const codeVerifier = `verifier-${randomUUID()}`;
    const nonce = `nonce-${randomUUID()}`;
    const browserBindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const expiresAt = new Date(Date.now() + 60_000);
    await oidcStore.create({
      stateDigest,
      browserBindingDigest,
      codeVerifier,
      nonce,
      expiresAt,
    });
    const rawPool = new Pool({ connectionString: apiUrl, max: 1 });
    const raw = await rawPool.connect();
    try {
      const row = await raw.query<{
        code_verifier_ciphertext: string;
        nonce_ciphertext: string;
        consumed_at: Date | null;
      }>(
        `select code_verifier_ciphertext, nonce_ciphertext, consumed_at
         from app.oidc_login_transactions where state_digest = $1`,
        [stateDigest],
      );
      expect(row.rows[0]?.code_verifier_ciphertext).not.toContain(codeVerifier);
      expect(row.rows[0]?.nonce_ciphertext).not.toContain(nonce);
      expect(row.rows[0]?.consumed_at).toBeNull();
    } finally {
      raw.release();
      await rawPool.end();
    }
    const wrongBindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    expect(
      (await oidcStore.consume(stateDigest, wrongBindingDigest, new Date()))
        .status,
    ).toBe('binding_mismatch');
    const [first, second] = await Promise.all([
      oidcStore.consume(stateDigest, browserBindingDigest, new Date()),
      oidcStore.consume(stateDigest, browserBindingDigest, new Date()),
    ]);
    expect([first.status, second.status].sort()).toEqual(['ok', 'replayed']);
    const successful = first.status === 'ok' ? first : second;
    if (successful.status !== 'ok')
      throw new Error('Expected one successful OIDC transaction consume');
    expect(successful.transaction.codeVerifier).toBe(codeVerifier);
    expect(successful.transaction.nonce).toBe(nonce);
    expect(
      (await oidcStore.consume(stateDigest, browserBindingDigest, new Date()))
        .status,
    ).toBe('replayed');

    const expiredDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await oidcStore.create({
      stateDigest: expiredDigest,
      browserBindingDigest,
      codeVerifier,
      nonce,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      (
        await oidcStore.consume(
          expiredDigest,
          browserBindingDigest,
          new Date(Date.now() + 120_000),
        )
      ).status,
    ).toBe('expired');
    await expect(
      oidcStore.consume(
        createHash('sha256').update(randomUUID()).digest('hex'),
        browserBindingDigest,
        new Date(),
      ),
    ).resolves.toEqual({ status: 'missing' });
  });

  it.each([1, 2])(
    'commits OIDC consumption when sealed field open %s fails',
    async (failedOpen) => {
      let openCount = 0;
      const failingStore = createOidcLoginTransactionStore(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          seal: (plaintext, associatedData) => ({
            ciphertext: Buffer.from(
              `${associatedData}:${plaintext}`,
              'utf8',
            ).toString('base64url'),
            nonce: 'test-nonce',
            tag: 'test-tag',
            keyVersion: 'test-v1',
          }),
          open: (sealed, associatedData) => {
            openCount += 1;
            if (openCount === failedOpen) throw new Error('open failed');
            const decoded = Buffer.from(
              sealed.ciphertext,
              'base64url',
            ).toString('utf8');
            return decoded.slice(`${associatedData}:`.length);
          },
        },
      );
      const transaction = oidcTransaction();
      try {
        await failingStore.create(transaction);
        await expect(
          failingStore.consume(
            transaction.stateDigest,
            transaction.browserBindingDigest,
            new Date(),
          ),
        ).rejects.toBeInstanceOf(OidcTransactionSealingError);
        const verifier = new Pool({ connectionString: apiUrl, max: 1 });
        try {
          const persisted = await verifier.query<{ consumed: boolean }>(
            `select consumed_at is not null as consumed
             from app.oidc_login_transactions where state_digest = $1`,
            [transaction.stateDigest],
          );
          expect(persisted.rows[0]?.consumed).toBe(true);
        } finally {
          await verifier.end();
        }
        await expect(
          failingStore.consume(
            transaction.stateDigest,
            transaction.browserBindingDigest,
            new Date(),
          ),
        ).resolves.toEqual({ status: 'replayed' });
      } finally {
        await failingStore.close();
      }
    },
  );

  it('fails closed on a corrupt stored OIDC seal and leaves it consumed', async () => {
    const transaction = oidcTransaction();
    await oidcStore.create(transaction);
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        `update app.oidc_login_transactions
         set code_verifier_ciphertext = 'corrupt' where state_digest = $1`,
        [transaction.stateDigest],
      );
    } finally {
      await owner.end();
    }

    await expect(
      oidcStore.consume(
        transaction.stateDigest,
        transaction.browserBindingDigest,
        new Date(),
      ),
    ).rejects.toBeInstanceOf(OidcTransactionSealingError);
    await expect(
      oidcStore.consume(
        transaction.stateDigest,
        transaction.browserBindingDigest,
        new Date(),
      ),
    ).resolves.toEqual({ status: 'replayed' });
  });

  it('guards OIDC admission with a locked owner function and no runtime cleanup privilege', async () => {
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const result = await pool.query<{
        can_delete: boolean;
        can_execute: boolean;
        owner: string;
        proconfig: string[] | null;
        prosecdef: boolean;
        runtime_roles_restricted: boolean;
        trigger_enabled: string;
      }>(`
        select
          pg_get_userbyid(proc.proowner) as owner,
          proc.prosecdef,
          proc.proconfig,
          has_function_privilege(
            current_user,
            proc.oid,
            'EXECUTE'
          ) as can_execute,
          has_table_privilege(
            current_user,
            'app.oidc_login_transactions',
            'DELETE'
          ) as can_delete,
          (
            select bool_and(
              not has_function_privilege(runtime.role_name, proc.oid, 'EXECUTE')
              and not has_table_privilege(
                runtime.role_name,
                'app.oidc_login_transactions',
                'DELETE'
              )
            )
            from (values
              ('pertexo_api'),
              ('pertexo_worker'),
              ('pertexo_dispatcher')
            ) as runtime(role_name)
          ) as runtime_roles_restricted,
          trig.tgenabled as trigger_enabled
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        join pg_trigger trig on trig.tgfoid = proc.oid
        where namespace.nspname = 'app'
          and proc.proname = 'enforce_oidc_login_transaction_capacity'
          and trig.tgname = 'oidc_login_transactions_capacity'
      `);
      expect(result.rows[0]).toEqual({
        owner: 'pertexo_owner',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        can_execute: false,
        can_delete: false,
        runtime_roles_restricted: true,
        trigger_enabled: 'O',
      });
    } finally {
      await pool.end();
    }
  });

  it('resumes stale OIDC cleanup in bounded batches', async () => {
    await replaceOidcTransactions({ stale: 1_001 });
    try {
      await oidcStore.create(oidcTransaction());
      const pool = new Pool({ connectionString: apiUrl, max: 1 });
      try {
        const first = await pool.query<{ stale: string; total: string }>(`
          select
            count(*) filter (where expires_at <= clock_timestamp())::text as stale,
            count(*)::text as total
          from app.oidc_login_transactions
        `);
        expect(first.rows[0]).toEqual({ stale: '1', total: '2' });
        await oidcStore.create(oidcTransaction());
        const second = await pool.query<{ stale: string; total: string }>(`
          select
            count(*) filter (where expires_at <= clock_timestamp())::text as stale,
            count(*)::text as total
          from app.oidc_login_transactions
        `);
        expect(second.rows[0]).toEqual({ stale: '0', total: '2' });
      } finally {
        await pool.end();
      }
    } finally {
      await clearOidcTransactions();
    }
  });

  it('atomically caps active OIDC transactions under concurrent admission', async () => {
    await replaceOidcTransactions({ active: 9_999 });
    try {
      const results = await Promise.allSettled([
        oidcStore.create(oidcTransaction()),
        oidcStore.create(oidcTransaction()),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected') {
        expect(rejected.reason).toBeInstanceOf(OidcTransactionCapacityError);
        expect(pgCode(rejected.reason)).toBe('54000');
      }
      const pool = new Pool({ connectionString: apiUrl, max: 1 });
      try {
        const active = await pool.query<{ count: string }>(`
          select count(*)::text as count
          from app.oidc_login_transactions
          where consumed_at is null and expires_at > clock_timestamp()
        `);
        expect(active.rows[0]?.count).toBe('10000');
      } finally {
        await pool.end();
      }
    } finally {
      await clearOidcTransactions();
    }
  });

  it('bounds retained OIDC rows even when transactions are consumed quickly', async () => {
    await replaceOidcTransactions({ consumed: 19_999 });
    try {
      await oidcStore.create(oidcTransaction());
      await expect(oidcStore.create(oidcTransaction())).rejects.toBeInstanceOf(
        OidcTransactionCapacityError,
      );
      const pool = new Pool({ connectionString: apiUrl, max: 1 });
      try {
        const total = await pool.query<{ count: string }>(
          'select count(*)::text as count from app.oidc_login_transactions',
        );
        expect(total.rows[0]?.count).toBe('20000');
      } finally {
        await pool.end();
      }
    } finally {
      await clearOidcTransactions();
    }
  });
});

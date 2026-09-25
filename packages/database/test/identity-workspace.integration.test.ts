import { createHash, randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
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
  WorkspaceRenameCommandConflictError,
  OidcTransactionCapacityError,
  OidcTransactionSealingError,
  parseDatabaseConfig,
  auditEvents,
  workspaceMemberships,
} from '../src/testing.js';
import { migrateDatabase } from '../src/migrations.js';
import { createWorkspaceInvitationDeliveryStore } from '../src/execution.js';
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
const adminDatabaseUrl = fixture.databaseUrl(adminUrl);
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

async function findActiveAuthenticationSession(token: string) {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const result = await pool.query<{ user_id: string }>(
      `select user_id
         from app.auth_sessions
        where token=$1 and expires_at > clock_timestamp()`,
      [token],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
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

  it('renames conditionally, replays exact commands, and never reapplies an old result', async () => {
    const target = await identityDatabase.createWorkspaceWithOwner({
      name: 'Rename target',
      slug: `rename-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const firstKey = `rename-${randomUUID()}`;
    const first = await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'First authoritative name',
      expectedRevision: 1,
      idempotencyKey: firstKey,
      requestId: 'rename-first',
    });
    expect(first).toMatchObject({
      changed: true,
      replayed: false,
      workspace: { name: 'First authoritative name', revision: 2 },
    });

    const replay = await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'First authoritative name',
      expectedRevision: 1,
      idempotencyKey: firstKey,
      requestId: 'rename-first-retry',
    });
    expect(replay).toMatchObject({
      changed: true,
      replayed: true,
      workspace: { name: 'First authoritative name', revision: 2 },
    });

    await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'Newer tab name',
      expectedRevision: 2,
      idempotencyKey: `rename-${randomUUID()}`,
    });
    const historicalReplay = await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'First authoritative name',
      expectedRevision: 1,
      idempotencyKey: firstKey,
    });
    expect(historicalReplay).toMatchObject({ replayed: true });

    const discovered =
      await identityDatabase.listAccessibleWorkspaces(ownerUserId);
    expect(
      discovered.items.find((item) => item.id === target.id),
    ).toMatchObject({ name: 'Newer tab name', revision: 3 });
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Stale overwrite',
        expectedRevision: 2,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ reason: 'revision_conflict' });
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Changed body',
        expectedRevision: 1,
        idempotencyKey: firstKey,
      }),
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' });

    const owner = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      const audit = await owner.query<{ count: string }>(
        `select count(*)::text count from app.audit_events
         where workspace_id=$1 and action='workspace.renamed'`,
        [target.id],
      );
      expect(audit.rows[0]?.count).toBe('2');
    } finally {
      await owner.end();
    }
  });

  it('serializes concurrent renames and authorizes against current database state', async () => {
    const target = await identityDatabase.createWorkspaceWithOwner({
      name: 'Concurrent rename target',
      slug: `rename-race-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const outcomes = await Promise.allSettled([
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Concurrent left',
        expectedRevision: 1,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Concurrent right',
        expectedRevision: 1,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected?.status !== 'rejected')
      throw new Error('Expected one rejected concurrent rename');
    expect(rejected.reason).toBeInstanceOf(WorkspaceRenameCommandConflictError);
    if (!(rejected.reason instanceof WorkspaceRenameCommandConflictError))
      throw new Error('Expected a workspace rename conflict');
    expect(rejected.reason.reason).toBe('revision_conflict');

    const actor = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Current-state manager',
    });
    const owner = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      await owner.query(
        `insert into app.workspace_memberships
           (workspace_id,user_id,role,status)
         values($1,$2,'admin','active')`,
        [target.id, actor.id],
      );
    } finally {
      await owner.end();
    }
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: actor.id,
        name: 'Admin-authorized name',
        expectedRevision: 2,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).resolves.toMatchObject({
      workspace: { name: 'Admin-authorized name', revision: 3 },
    });
    const demoter = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      await demoter.query(
        `update app.workspace_memberships set role='builder'
         where workspace_id=$1 and user_id=$2`,
        [target.id, actor.id],
      );
    } finally {
      await demoter.end();
    }
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: actor.id,
        name: 'Forbidden builder name',
        expectedRevision: 3,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(WorkspaceRenameCommandConflictError);

    const inactive = await identityDatabase.createWorkspaceWithOwner({
      name: 'Inactive rename target',
      slug: `inactive-rename-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const suspender = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      await suspender.query(
        "update app.workspaces set status='suspended' where id=$1",
        [inactive.id],
      );
    } finally {
      await suspender.end();
    }
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: inactive.id,
        actorUserId: ownerUserId,
        name: 'Forbidden inactive name',
        expectedRevision: 1,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ reason: 'workspace_inactive' });
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
        metadata: { tokenDigest: 'must-not-persist' },
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

  it('creates one pending invitation, replays exactly, and arbitrates concurrent duplicates', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation creation',
        slug: `invite-create-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const command = invitationCreateCommand(
      invitationWorkspace.id,
      ownerUserId,
      `${randomUUID()}@example.test`,
    );
    const first = await identityDatabase.createWorkspaceInvitation(command);
    await expect(
      identityDatabase.createWorkspaceInvitation(command),
    ).resolves.toMatchObject({
      replayed: true,
      invitation: { id: first.invitation.id },
    });
    await expect(
      identityDatabase.createWorkspaceInvitation({
        ...command,
        role: 'builder',
      }),
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' });

    const email = `${randomUUID()}@example.test`;
    const results = await Promise.allSettled([
      identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(invitationWorkspace.id, ownerUserId, email),
      ),
      identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(invitationWorkspace.id, ownerUserId, email),
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const page = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    expect(page.items.filter((item) => item.email === email)).toHaveLength(1);
  });

  it('lists members and invitations side by side without a lock cycle', async () => {
    // The Team page reads both at once; each read must succeed however the
    // two interleave, and while an invitation is being created.
    const teamWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Concurrent team reads',
      slug: `team-reads-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const reads = Array.from({ length: 24 }, (_, index) =>
      index % 2 === 0
        ? identityDatabase.listWorkspaceMembers(teamWorkspace.id, ownerUserId)
        : identityDatabase.listWorkspaceInvitations(
            teamWorkspace.id,
            ownerUserId,
          ),
    );
    const created = identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        teamWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
    );
    const settled = await Promise.allSettled([...reads, created]);
    expect(settled.filter((outcome) => outcome.status === 'rejected')).toEqual(
      [],
    );
  });

  it('authorizes invitations from current roles and keeps workspace rows isolated', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation authority',
        slug: `invite-authority-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const otherWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Invitation isolation',
      slug: `invite-isolation-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const admin = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Invitation admin',
    });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.insert(workspaceMemberships).values({
          workspaceId: invitationWorkspace.id,
          userId: admin.id,
          role: 'admin',
          status: 'active',
        });
      },
    );

    await expect(
      identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          invitationWorkspace.id,
          admin.id,
          `${randomUUID()}@example.test`,
        ),
        role: 'builder',
      }),
    ).resolves.toMatchObject({ invitation: { role: 'builder' } });
    await expect(
      identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          invitationWorkspace.id,
          admin.id,
          `${randomUUID()}@example.test`,
        ),
        role: 'admin',
      }),
    ).rejects.toMatchObject({ reason: 'role_forbidden' });

    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db
          .update(workspaceMemberships)
          .set({ role: 'viewer' })
          .where(eq(workspaceMemberships.userId, admin.id));
      },
    );
    await expect(
      identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(
          invitationWorkspace.id,
          admin.id,
          `${randomUUID()}@example.test`,
        ),
      ),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
    await expect(
      identityDatabase.listWorkspaceInvitations(otherWorkspace.id, admin.id),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
  });

  it('invalidates resolved intents on resend and preserves the new generation', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation generation',
        slug: `invite-generation-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const created = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
    );
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        tokenDigest: invitationTokenDigest(created.invitation.id),
        intentId,
        bindingDigest,
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).resolves.toBeNull();

    const knownDigest = createHash('sha256')
      .update('known-secret')
      .digest('hex');
    const known = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: knownDigest,
    });
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: known.invitation.id,
        tokenDigest: knownDigest,
        intentId,
        bindingDigest,
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).resolves.toMatchObject({ status: 'pending', invitationRevision: 1 });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='failed',token_ciphertext=null,token_nonce=null,
                 token_tag=null,token_key_version=null
           where invitation_id=${known.invitation.id}::uuid
             and invitation_revision=1
        `);
      },
    );
    await identityDatabase.resendWorkspaceInvitation({
      workspaceId: invitationWorkspace.id,
      actorUserId: ownerUserId,
      invitationId: known.invitation.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      tokenDigest: createHash('sha256').update('new-secret').digest('hex'),
      sealedToken: testSealedToken(),
      deliveryAttemptId: randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    });
    await expect(
      identityDatabase.readInvitationAcceptance(
        invitationWorkspace.id,
        bindingDigest,
      ),
    ).resolves.toMatchObject({ status: 'superseded', invitationRevision: 1 });
  });

  it('invalidates a replaced browser binding without revoking the invitation', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation binding replacement',
        slug: `invite-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Binding replacement recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('binding-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const oldIntentId = randomUUID();
    const oldBinding = createHash('sha256').update(randomUUID()).digest('hex');
    const newIntentId = randomUUID();
    const newBinding = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256')
        .update(`csrf:${oldIntentId}`)
        .digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId: newIntentId,
      bindingDigest: newBinding,
      csrfDigest: createHash('sha256')
        .update(`csrf:${newIntentId}`)
        .digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: invitationWorkspace.id,
        intentId: oldIntentId,
        bindingDigest: oldBinding,
      },
    });

    await expect(
      identityDatabase.recordInvitationAcceptanceProof({
        workspaceId: invitationWorkspace.id,
        intentId: oldIntentId,
        bindingDigest: oldBinding,
        userId: recipient.id,
        verifiedEmail: recipient.email,
        verifiedAt: new Date(),
      }),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.recordInvitationAcceptanceProof({
        workspaceId: invitationWorkspace.id,
        intentId: newIntentId,
        bindingDigest: newBinding,
        userId: recipient.id,
        verifiedEmail: recipient.email,
        verifiedAt: new Date(),
      }),
    ).resolves.toMatchObject({ status: 'verified' });
    const invitations = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    expect(
      invitations.items.find((item) => item.id === created.invitation.id),
    ).toMatchObject({ status: 'pending' });
  });

  it('recovers the exact committed replacement while rejecting a competing journey', async () => {
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Resolver recovery prior',
      slug: `resolver-recovery-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const targetWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Resolver recovery target',
      slug: `resolver-recovery-target-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const priorTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const priorInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        priorWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: priorTokenDigest,
    });
    const priorIntentId = randomUUID();
    const priorBindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: priorWorkspace.id,
      invitationId: priorInvitation.invitation.id,
      tokenDigest: priorTokenDigest,
      intentId: priorIntentId,
      bindingDigest: priorBindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const targetTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const targetInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        targetWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: targetTokenDigest,
    });
    const competingTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const competingInvitation =
      await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          targetWorkspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest: competingTokenDigest,
      });
    const replacement = {
      workspaceId: targetWorkspace.id,
      invitationId: targetInvitation.invitation.id,
      tokenDigest: targetTokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: priorIntentId,
        bindingDigest: priorBindingDigest,
      },
    };
    const committed =
      await identityDatabase.resolveInvitationAcceptance(replacement);
    expect(committed).toMatchObject({
      id: replacement.intentId,
      status: 'pending',
    });

    const competitor = {
      ...replacement,
      invitationId: competingInvitation.invitation.id,
      tokenDigest: competingTokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    };
    const [recovered, rejectedCompetitor] = await Promise.all([
      identityDatabase.resolveInvitationAcceptance(replacement),
      identityDatabase.resolveInvitationAcceptance(competitor),
    ]);
    expect(recovered).toMatchObject({
      id: replacement.intentId,
      status: 'pending',
    });
    expect(rejectedCompetitor).toBeNull();
    await expect(
      identityDatabase.readInvitationAcceptance(
        priorWorkspace.id,
        priorBindingDigest,
      ),
    ).resolves.toMatchObject({ status: 'abandoned' });
    await tenantDatabase.withWorkspace(targetWorkspace.id, async ({ db }) => {
      const durable = await db.execute(sql<{ count: number; kind: string }>`
          select 'membership' kind,count(*)::int count
            from app.workspace_memberships
           where workspace_id=${targetWorkspace.id}::uuid
          union all
          select 'acceptance_audit' kind,count(*)::int count
            from app.audit_events
           where workspace_id=${targetWorkspace.id}::uuid
             and action='workspace.invitation_accepted'
        `);
      expect(durable.rows).toEqual(
        expect.arrayContaining([
          { kind: 'membership', count: 1 },
          { kind: 'acceptance_audit', count: 0 },
        ]),
      );
    });
    await tenantDatabase.withWorkspace(targetWorkspace.id, async ({ db }) => {
      await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='failed',token_ciphertext=null,token_nonce=null,
                 token_tag=null,token_key_version=null
           where invitation_id=${targetInvitation.invitation.id}::uuid
             and invitation_revision=1
        `);
    });
    const refreshedTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resendWorkspaceInvitation({
      workspaceId: targetWorkspace.id,
      actorUserId: ownerUserId,
      invitationId: targetInvitation.invitation.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      tokenDigest: refreshedTokenDigest,
      sealedToken: testSealedToken(),
      deliveryAttemptId: randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    });
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        ...replacement,
        tokenDigest: refreshedTokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      }),
    ).resolves.toMatchObject({
      invitationId: targetInvitation.invitation.id,
      invitationRevision: 2,
      status: 'pending',
    });
  });

  it('replaces a superseded resend journey with the valid new generation', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation resend replacement',
        slug: `invite-resend-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const oldTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: oldTokenDigest,
    });
    const oldIntentId = randomUUID();
    const oldBinding = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest: oldTokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='failed',token_ciphertext=null,token_nonce=null,
                 token_tag=null,token_key_version=null
           where invitation_id=${created.invitation.id}::uuid
             and invitation_revision=1
        `);
      },
    );
    const newTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resendWorkspaceInvitation({
      workspaceId: invitationWorkspace.id,
      actorUserId: ownerUserId,
      invitationId: created.invitation.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      tokenDigest: newTokenDigest,
      sealedToken: testSealedToken(),
      deliveryAttemptId: randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        tokenDigest: newTokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: {
          workspaceId: invitationWorkspace.id,
          intentId: oldIntentId,
          bindingDigest: oldBinding,
        },
      }),
    ).resolves.toMatchObject({ status: 'pending', invitationRevision: 2 });
    await expect(
      identityDatabase.readInvitationAcceptance(
        invitationWorkspace.id,
        oldBinding,
      ),
    ).resolves.toMatchObject({ status: 'superseded' });
  });

  it('does not resurrect an abandoned replacement after its successor becomes current', async () => {
    const makeJourney = async (label: string) => {
      const workspace = await identityDatabase.createWorkspaceWithOwner({
        name: `Replacement ${label}`,
        slug: `replacement-${label.toLowerCase()}-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      });
      const tokenDigest = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const invitation = await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          workspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest,
      });
      return { workspace, tokenDigest, invitation: invitation.invitation };
    };
    const a = await makeJourney('A');
    const b = await makeJourney('B');
    const c = await makeJourney('C');
    const d = await makeJourney('D');
    const e = await makeJourney('E');
    const commandA = {
      workspaceId: a.workspace.id,
      invitationId: a.invitation.id,
      tokenDigest: a.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    await identityDatabase.resolveInvitationAcceptance(commandA);
    const commandB = {
      workspaceId: b.workspace.id,
      invitationId: b.invitation.id,
      tokenDigest: b.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: a.workspace.id,
        intentId: commandA.intentId,
        bindingDigest: commandA.bindingDigest,
      },
    };
    await expect(
      identityDatabase.resolveInvitationAcceptance(commandB),
    ).resolves.toMatchObject({ id: commandB.intentId, status: 'pending' });
    const commandC = {
      workspaceId: c.workspace.id,
      invitationId: c.invitation.id,
      tokenDigest: c.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: b.workspace.id,
        intentId: commandB.intentId,
        bindingDigest: commandB.bindingDigest,
      },
    };
    await expect(
      identityDatabase.resolveInvitationAcceptance(commandC),
    ).resolves.toMatchObject({ id: commandC.intentId, status: 'pending' });

    await expect(
      identityDatabase.resolveInvitationAcceptance(commandB),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: d.workspace.id,
        invitationId: d.invitation.id,
        tokenDigest: d.tokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: commandB.priorBinding,
      }),
    ).resolves.toBeNull();
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        'delete from app.workspace_invitation_acceptance_intents where id=$1',
        [commandB.intentId],
      );
    } finally {
      await owner.end();
    }
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: e.workspace.id,
        invitationId: e.invitation.id,
        tokenDigest: e.tokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: commandB.priorBinding,
      }),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.readInvitationAcceptance(
        c.workspace.id,
        commandC.bindingDigest,
      ),
    ).resolves.toMatchObject({ id: commandC.intentId, status: 'pending' });
    await expect(
      identityDatabase.readInvitationAcceptance(
        b.workspace.id,
        commandB.bindingDigest,
      ),
    ).resolves.toBeNull();
  });

  it('replaces a terminal successor across workspaces without exposing its tenant row', async () => {
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Cross-workspace prior',
      slug: `cross-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const firstTarget = await identityDatabase.createWorkspaceWithOwner({
      name: 'Cross-workspace terminal target',
      slug: `cross-terminal-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const finalTarget = await identityDatabase.createWorkspaceWithOwner({
      name: 'Cross-workspace fresh target',
      slug: `cross-fresh-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const createInvitation = async (workspaceId: string) => {
      const tokenDigest = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const created = await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          workspaceId,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest,
      });
      return { tokenDigest, invitationId: created.invitation.id };
    };
    const priorInvitation = await createInvitation(priorWorkspace.id);
    const firstInvitation = await createInvitation(firstTarget.id);
    const finalInvitation = await createInvitation(finalTarget.id);
    const prior = {
      workspaceId: priorWorkspace.id,
      invitationId: priorInvitation.invitationId,
      tokenDigest: priorInvitation.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    await identityDatabase.resolveInvitationAcceptance(prior);
    const first = {
      workspaceId: firstTarget.id,
      invitationId: firstInvitation.invitationId,
      tokenDigest: firstInvitation.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: prior.intentId,
        bindingDigest: prior.bindingDigest,
      },
    };
    await identityDatabase.resolveInvitationAcceptance(first);
    await tenantDatabase.withWorkspace(firstTarget.id, async ({ db }) => {
      await db.execute(sql`
        update app.workspace_invitation_acceptance_intents
           set status='superseded',updated_at=clock_timestamp()
         where id=${first.intentId}::uuid
      `);
    });
    const final = {
      workspaceId: finalTarget.id,
      invitationId: finalInvitation.invitationId,
      tokenDigest: finalInvitation.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: first.priorBinding,
    };

    const cleanupPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const cleanupClient = await cleanupPool.connect();
    try {
      await cleanupClient.query('set role pertexo_owner');
      const [cleanup, resolution] = await Promise.allSettled([
        cleanupClient.query(
          'select * from app.reap_workspace_invitation_transients(100)',
        ),
        identityDatabase.resolveInvitationAcceptance(final),
      ]);
      expect(cleanup.status).toBe('fulfilled');
      expect(resolution).toMatchObject({
        status: 'fulfilled',
        value: { id: final.intentId, status: 'pending' },
      });
    } finally {
      cleanupClient.release();
      await cleanupPool.end();
    }
    await expect(
      identityDatabase.readInvitationAcceptance(
        firstTarget.id,
        first.bindingDigest,
      ),
    ).resolves.toMatchObject({ status: 'superseded' });
  });

  it('opens another invitation without mutating a completed receipt journey', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Completed invitation replacement',
        slug: `invite-completed-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Completed binding recipient',
    });
    const firstTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const first = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest: firstTokenDigest,
    });
    const completedIntentId = randomUUID();
    const completedBinding = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: first.invitation.id,
      tokenDigest: firstTokenDigest,
      intentId: completedIntentId,
      bindingDigest: completedBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId: completedIntentId,
      bindingDigest: completedBinding,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const replacementSessionToken = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.completeInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      intentId: completedIntentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: randomUUID(),
      replacementSession: {
        authority: 'better_auth',
        id: randomUUID(),
        token: replacementSessionToken,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const secondTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const second = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: secondTokenDigest,
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: second.invitation.id,
        tokenDigest: secondTokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: {
          workspaceId: invitationWorkspace.id,
          intentId: completedIntentId,
          bindingDigest: completedBinding,
        },
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      invitationId: second.invitation.id,
    });
    await expect(
      identityDatabase.readInvitationAcceptance(
        invitationWorkspace.id,
        completedBinding,
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      acceptedUserId: recipient.id,
    });
    await expect(
      findActiveAuthenticationSession(replacementSessionToken),
    ).resolves.toEqual({ user_id: recipient.id });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const durable = await db.execute(sql<{ count: number; kind: string }>`
          select 'membership' kind,count(*)::int count
            from app.workspace_memberships where user_id=${recipient.id}::uuid
          union all
          select 'audit' kind,count(*)::int count
            from app.audit_events
           where action='workspace.invitation_accepted'
             and actor_user_id=${recipient.id}::uuid
        `);
        expect(durable.rows).toEqual(
          expect.arrayContaining([
            { kind: 'membership', count: 1 },
            { kind: 'audit', count: 1 },
          ]),
        );
      },
    );
  });

  it('keeps an unexpired completed successor live against a stale ancestor replacement', async () => {
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Completed lineage prior',
      slug: `completed-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const successorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Completed lineage successor',
      slug: `completed-successor-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const staleWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Completed lineage stale target',
      slug: `completed-stale-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Completed lineage recipient',
    });
    const createJourney = async (workspaceId: string, email: string) => {
      const tokenDigest = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const invitation = await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(workspaceId, ownerUserId, email),
        tokenDigest,
      });
      return { invitation: invitation.invitation, tokenDigest };
    };
    const prior = await createJourney(
      priorWorkspace.id,
      `${randomUUID()}@example.test`,
    );
    const successor = await createJourney(
      successorWorkspace.id,
      recipient.email,
    );
    const stale = await createJourney(
      staleWorkspace.id,
      `${randomUUID()}@example.test`,
    );
    const priorIntent = {
      workspaceId: priorWorkspace.id,
      invitationId: prior.invitation.id,
      tokenDigest: prior.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    await identityDatabase.resolveInvitationAcceptance(priorIntent);
    const successorIntent = {
      workspaceId: successorWorkspace.id,
      invitationId: successor.invitation.id,
      tokenDigest: successor.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: priorIntent.intentId,
        bindingDigest: priorIntent.bindingDigest,
      },
    };
    await identityDatabase.resolveInvitationAcceptance(successorIntent);
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: successorWorkspace.id,
      intentId: successorIntent.intentId,
      bindingDigest: successorIntent.bindingDigest,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    await identityDatabase.completeInvitationAcceptance({
      workspaceId: successorWorkspace.id,
      intentId: successorIntent.intentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: randomUUID(),
      replacementSession: {
        authority: 'better_auth',
        id: randomUUID(),
        token: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: staleWorkspace.id,
        invitationId: stale.invitation.id,
        tokenDigest: stale.tokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: successorIntent.priorBinding,
      }),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.readInvitationAcceptance(
        successorWorkspace.id,
        successorIntent.bindingDigest,
      ),
    ).resolves.toMatchObject({
      id: successorIntent.intentId,
      status: 'completed',
    });
  });

  it('serializes replacement-claim cleanup with acceptance without duplicating durable effects', async () => {
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Claim cleanup acceptance recipient',
    });
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Claim cleanup acceptance prior',
      slug: `claim-cleanup-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const targetWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Claim cleanup acceptance target',
      slug: `claim-cleanup-target-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const priorTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const targetTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const priorInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        priorWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: priorTokenDigest,
    });
    const targetInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        targetWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest: targetTokenDigest,
    });
    const priorIntentId = randomUUID();
    const priorBindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: priorWorkspace.id,
      invitationId: priorInvitation.invitation.id,
      tokenDigest: priorTokenDigest,
      intentId: priorIntentId,
      bindingDigest: priorBindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const targetIntentId = randomUUID();
    const targetBindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: targetWorkspace.id,
      invitationId: targetInvitation.invitation.id,
      tokenDigest: targetTokenDigest,
      intentId: targetIntentId,
      bindingDigest: targetBindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: priorIntentId,
        bindingDigest: priorBindingDigest,
      },
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: targetWorkspace.id,
      intentId: targetIntentId,
      bindingDigest: targetBindingDigest,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const command = {
      workspaceId: targetWorkspace.id,
      intentId: targetIntentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: randomUUID(),
      replacementSession: {
        authority: 'better_auth' as const,
        id: randomUUID(),
        token: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    const cleanupPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const cleanupClient = await cleanupPool.connect();
    try {
      await cleanupClient.query('set role pertexo_owner');
      const [cleanup, accepted] = await Promise.allSettled([
        cleanupClient.query(
          'select * from app.reap_workspace_invitation_transients(100)',
        ),
        identityDatabase.completeInvitationAcceptance(command),
      ]);
      expect(cleanup.status).toBe('fulfilled');
      expect(accepted).toMatchObject({
        status: 'fulfilled',
        value: { membershipCreated: true, replayed: false },
      });
    } finally {
      cleanupClient.release();
      await cleanupPool.end();
    }
    await expect(
      identityDatabase.completeInvitationAcceptance(command),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: true });
    await tenantDatabase.withWorkspace(targetWorkspace.id, async ({ db }) => {
      const durable = await db.execute(sql<{ count: number; kind: string }>`
        select 'membership' kind,count(*)::integer count
          from app.workspace_memberships where user_id=${recipient.id}::uuid
        union all
        select 'audit' kind,count(*)::integer count from app.audit_events
         where action='workspace.invitation_accepted'
           and actor_user_id=${recipient.id}::uuid
      `);
      expect(durable.rows).toEqual(
        expect.arrayContaining([
          { kind: 'membership', count: 1 },
          { kind: 'audit', count: 1 },
        ]),
      );
    });
  });

  it('opens a valid invitation when the cookie references a pruned intent', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Pruned invitation replacement',
        slug: `invite-pruned-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const oldTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const oldInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: oldTokenDigest,
    });
    const oldIntentId = randomUUID();
    const oldBinding = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: oldInvitation.invitation.id,
      tokenDigest: oldTokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        'delete from app.workspace_invitation_acceptance_intents where id=$1',
        [oldIntentId],
      );
    } finally {
      await owner.end();
    }
    const validTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const validInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: validTokenDigest,
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: validInvitation.invitation.id,
        tokenDigest: validTokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: {
          workspaceId: invitationWorkspace.id,
          intentId: oldIntentId,
          bindingDigest: oldBinding,
        },
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      invitationId: validInvitation.invitation.id,
    });
  });

  it('allows only one concurrent replacement of the same browser binding and rolls back failed replacement', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation binding concurrency',
        slug: `invite-binding-race-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const tokenDigest = createHash('sha256').update(randomUUID()).digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest,
    });
    const oldIntentId = randomUUID();
    const oldBinding = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const replacementWorkspace =
      await identityDatabase.createWorkspaceWithOwner({
        name: 'Invitation binding replacement target',
        slug: `invite-binding-target-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      });
    const replacementTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const replacementInvitation =
      await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          replacementWorkspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest: replacementTokenDigest,
      });
    const replacement = () => ({
      workspaceId: replacementWorkspace.id,
      invitationId: replacementInvitation.invitation.id,
      tokenDigest: replacementTokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: invitationWorkspace.id,
        intentId: oldIntentId,
        bindingDigest: oldBinding,
      },
    });
    const replacementA = replacement();
    const replacementB = replacement();
    const outcomes = await Promise.all([
      identityDatabase.resolveInvitationAcceptance(replacementA),
      identityDatabase.resolveInvitationAcceptance(replacementB),
    ]);
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
    await tenantDatabase.withWorkspace(
      replacementWorkspace.id,
      async ({ db }) => {
        const active = await db.execute(sql`
          select count(*)::int count
            from app.workspace_invitation_acceptance_intents
           where invitation_id=${replacementInvitation.invitation.id}::uuid
             and status in ('pending','verified','wrong_account')
        `);
        expect(active.rows[0]?.count).toBe(1);
      },
    );

    const active = outcomes.find((outcome) => outcome !== null);
    expect(active).not.toBeNull();
    const activeBinding =
      active?.id === replacementA.intentId
        ? replacementA.bindingDigest
        : replacementB.bindingDigest;
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        ...replacement(),
        bindingDigest: activeBinding,
        priorBinding: {
          workspaceId: replacementWorkspace.id,
          intentId: active?.id ?? oldIntentId,
          bindingDigest: activeBinding,
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      identityDatabase.readInvitationAcceptance(
        replacementWorkspace.id,
        activeBinding,
      ),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('does not rotate an invitation while delivery outcome is unknown', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation delivery recovery',
        slug: `invite-delivery-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const created = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
    );
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='unknown'
           where invitation_id=${created.invitation.id}::uuid
             and invitation_revision=1
        `);
      },
    );

    await expect(
      identityDatabase.resendWorkspaceInvitation({
        workspaceId: invitationWorkspace.id,
        actorUserId: ownerUserId,
        invitationId: created.invitation.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        tokenDigest: createHash('sha256').update('new-secret').digest('hex'),
        sealedToken: testSealedToken(),
        deliveryAttemptId: randomUUID(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      }),
    ).rejects.toMatchObject({ reason: 'delivery_unresolved' });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const attempt = await db.execute(sql<{ id: string }>`
          select status,token_ciphertext is not null sealed
            from app.workspace_invitation_delivery_attempts
           where invitation_id=${created.invitation.id}::uuid
             and invitation_revision=1
        `);
        expect(attempt.rows[0]).toEqual({ status: 'unknown', sealed: true });
      },
    );
  });

  it('keeps invitation delivery rendering stable across a workspace rename', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Original delivery name',
        slug: `invite-snapshot-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const created = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
    );
    let deliveryAttemptId = '';
    let outboxEventId = '';
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const rows = await db.execute<{
          attempt_id: string;
          outbox_id: string;
        }>(sql`
        select attempt.id attempt_id,outbox.id outbox_id
          from app.workspace_invitation_delivery_attempts attempt
          join app.outbox_events outbox
            on outbox.aggregate_id=attempt.invitation_id
           and outbox.payload->>'deliveryAttemptId'=attempt.id::text
         where attempt.invitation_id=${created.invitation.id}::uuid
      `);
        deliveryAttemptId = rows.rows[0]?.attempt_id ?? '';
        outboxEventId = rows.rows[0]?.outbox_id ?? '';
      },
    );
    const deliveryStore = createWorkspaceInvitationDeliveryStore(
      parseDatabaseConfig({ connectionString: workerUrl, max: 1 }),
    );
    try {
      const first = await deliveryStore.claim({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        deliveryAttemptId,
        outboxEventId,
      });
      await identityDatabase.renameWorkspace({
        workspaceId: invitationWorkspace.id,
        actorUserId: ownerUserId,
        name: 'Renamed after dispatch uncertainty',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const retried = await deliveryStore.claim({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        deliveryAttemptId,
        outboxEventId,
      });
      expect(first).toMatchObject({
        kind: 'ready',
        workspaceName: 'Original delivery name',
      });
      expect(retried).toMatchObject(first);
    } finally {
      await deliveryStore.close();
    }
  });

  it('keeps delivery and invitation commands deadlock-free under concurrency', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation lock ordering',
        slug: `invite-locks-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const created = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
    );
    let deliveryAttemptId = '';
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const attempt = await db.execute<{ id: string }>(sql`
          select id from app.workspace_invitation_delivery_attempts
           where invitation_id=${created.invitation.id}::uuid
        `);
        deliveryAttemptId = attempt.rows[0]?.id ?? '';
      },
    );
    const delivery = createWorkspaceInvitationDeliveryStore(
      parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
    );
    try {
      await delivery.markDispatching({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        deliveryAttemptId,
      });
      const concurrent = Promise.allSettled([
        delivery.complete({
          workspaceId: invitationWorkspace.id,
          invitationId: created.invitation.id,
          deliveryAttemptId,
          status: 'submitted',
          providerReference: 'provider-lock-order-proof',
        }),
        identityDatabase.revokeWorkspaceInvitation({
          workspaceId: invitationWorkspace.id,
          actorUserId: ownerUserId,
          invitationId: created.invitation.id,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ]);
      const outcomes = await Promise.race([
        concurrent,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('invitation lock timeout'));
          }, 5_000);
        }),
      ]);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(
        true,
      );
      const invitation = await identityDatabase.listWorkspaceInvitations(
        invitationWorkspace.id,
        ownerUserId,
      );
      expect(
        invitation.items.find((item) => item.id === created.invitation.id),
      ).toMatchObject({ status: 'revoked', deliveryStatus: 'canceled' });
      await tenantDatabase.withWorkspace(
        invitationWorkspace.id,
        async ({ db }) => {
          const attempt = await db.execute(sql<{
            provider_reference: string | null;
            status: string;
          }>`
            select provider_reference,status
              from app.workspace_invitation_delivery_attempts
             where id=${deliveryAttemptId}::uuid
          `);
          expect(attempt.rows[0]).toEqual({
            provider_reference: 'provider-lock-order-proof',
            status: 'submitted',
          });
        },
      );
    } finally {
      await delivery.close();
    }
  });

  it('expires sealed attempts before reinviting the same normalized recipient', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation reinvite',
        slug: `invite-reinvite-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const email = `${randomUUID()}@example.test`;
    const first = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(invitationWorkspace.id, ownerUserId, email),
    );
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
        update app.workspace_invitations
            set expires_at=clock_timestamp()-interval '1 second'
          where id=${first.invitation.id}::uuid
      `);
      },
    );

    const replacement = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        email.toUpperCase(),
      ),
    );
    expect(replacement.invitation.id).not.toBe(first.invitation.id);
    const page = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    expect(
      page.items.find((item) => item.id === first.invitation.id),
    ).toMatchObject({ status: 'expired', deliveryStatus: 'canceled' });
    expect(
      page.items.find((item) => item.id === replacement.invitation.id),
    ).toMatchObject({ status: 'pending' });
  });

  it('accepts once, rotates sessions atomically, and replays the historical receipt', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation acceptance',
        slug: `invite-accept-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Invited recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('accept-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const oldDigest = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.createSession({
      userId: recipient.id,
      tokenDigest: oldDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const replacementToken = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const key = randomUUID();
    const command = {
      workspaceId: invitationWorkspace.id,
      intentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: key,
      replacementSession: {
        authority: 'better_auth' as const,
        id: randomUUID(),
        token: replacementToken,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    await expect(
      identityDatabase.completeInvitationAcceptance(command),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: false });
    await expect(
      identityDatabase.findActiveSessionByDigest(oldDigest),
    ).resolves.toBeNull();
    await expect(
      findActiveAuthenticationSession(replacementToken),
    ).resolves.toEqual({ user_id: recipient.id });
    await expect(
      identityDatabase.recordInvitationAcceptanceProof({
        workspaceId: invitationWorkspace.id,
        intentId,
        bindingDigest,
        userId: recipient.id,
        verifiedEmail: recipient.email,
        verifiedAt: new Date(),
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      acceptedUserId: recipient.id,
    });
    await expect(
      identityDatabase.completeInvitationAcceptance(command),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: true });
    await expect(
      identityDatabase.completeInvitationAcceptance({
        ...command,
        invitationRevision: 2,
      }),
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' });
    await expect(
      identityDatabase.completeInvitationAcceptance({
        ...command,
        invitationRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: true });
    await expect(
      identityDatabase.findWorkspaceAccess(
        recipient.id,
        invitationWorkspace.id,
      ),
    ).resolves.toMatchObject({ role: 'viewer', membershipStatus: 'active' });
  });

  it('installs a digest-only replacement for the legacy opaque session authority', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Opaque session acceptance',
        slug: `invite-opaque-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Opaque session recipient',
    });
    const tokenDigest = createHash('sha256').update(randomUUID()).digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const oldDigest = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.createSession({
      userId: recipient.id,
      tokenDigest: oldDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const replacementDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const replacementId = randomUUID();

    await expect(
      identityDatabase.completeInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipient.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          authority: 'opaque',
          id: replacementId,
          tokenDigest: replacementDigest,
          expiresAt: new Date(Date.now() + 60_000),
          userAgent: 'opaque-acceptance-test',
        },
      }),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: false });
    await expect(
      identityDatabase.findActiveSessionByDigest(oldDigest),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.findActiveSessionByDigest(replacementDigest),
    ).resolves.toMatchObject({
      id: replacementId,
      userId: recipient.id,
      userAgent: 'opaque-acceptance-test',
    });
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const betterAuthSessions = await pool.query<{ count: number }>(
        'select count(*)::int count from app.auth_sessions where user_id=$1',
        [recipient.id],
      );
      expect(betterAuthSessions.rows).toEqual([{ count: 0 }]);
    } finally {
      await pool.end();
    }
  });

  it('rechecks active user status under the acceptance transaction lock', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Suspended invitation recipient',
        slug: `invite-suspended-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Suspended recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('suspended-recipient-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const observer = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    let completion: Promise<unknown> | undefined;
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(`update app.users set status='suspended' where id=$1`, [
        recipient.id,
      ]);
      completion = identityDatabase.completeInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipient.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          authority: 'better_auth',
          id: randomUUID(),
          token: createHash('sha256').update(randomUUID()).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      void completion.catch(() => undefined);
      await expect
        .poll(
          async () => {
            const blocked = await observer.query<{ blocked: boolean }>(
              `select exists(
                 select 1 from pg_stat_activity
                  where datname=current_database()
                    and usename=$1 and wait_event_type='Lock'
                    and query like '%select status from app.users%'
               ) blocked`,
              [new URL(apiUrl).username],
            );
            return blocked.rows[0]?.blocked;
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await Promise.all([owner.end(), observer.end()]);
    }

    await expect(completion).rejects.toMatchObject({
      reason: 'member_inactive',
    });
    await expect(
      identityDatabase.findWorkspaceAccess(
        recipient.id,
        invitationWorkspace.id,
      ),
    ).resolves.toBeNull();
  });

  it('accepts an active existing member as a no-op without changing role or sessions', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Existing member invitation',
        slug: `invite-member-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Existing invitation member',
    });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.insert(workspaceMemberships).values({
          workspaceId: invitationWorkspace.id,
          userId: recipient.id,
          role: 'operator',
          status: 'active',
        });
      },
    );
    const sessionDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.createSession({
      userId: recipient.id,
      tokenDigest: sessionDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const tokenDigest = createHash('sha256')
      .update('existing-member-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    await expect(
      identityDatabase.completeInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipient.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          authority: 'better_auth',
          id: randomUUID(),
          token: createHash('sha256').update(randomUUID()).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).resolves.toMatchObject({
      membershipCreated: false,
      role: 'operator',
      replacementSessionCreated: false,
    });
    await expect(
      identityDatabase.findActiveSessionByDigest(sessionDigest),
    ).resolves.toMatchObject({ userId: recipient.id });
  });

  it('serializes acceptance against revocation so exactly one lifecycle command wins', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation lifecycle race',
        slug: `invite-race-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Invitation race recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('race-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });

    const outcomes = await Promise.allSettled([
      identityDatabase.completeInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipient.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          authority: 'better_auth',
          id: randomUUID(),
          token: createHash('sha256').update(randomUUID()).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      identityDatabase.revokeWorkspaceInvitation({
        workspaceId: invitationWorkspace.id,
        actorUserId: ownerUserId,
        invitationId: created.invitation.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const access = await identityDatabase.findWorkspaceAccess(
      recipient.id,
      invitationWorkspace.id,
    );
    const page = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    const invitation = page.items.find(
      (item) => item.id === created.invitation.id,
    );
    expect(
      (access === null && invitation?.status === 'revoked') ||
        (access?.membershipStatus === 'active' &&
          invitation?.status === 'accepted'),
    ).toBe(true);
  });
});

function testSealedToken() {
  return {
    ciphertext: 'sealed-token',
    nonce: 'nonce',
    tag: 'tag',
    keyVersion: 'test-v1',
  };
}

function invitationTokenDigest(invitationId: string) {
  return createHash('sha256').update(invitationId).digest('hex');
}

function invitationCreateCommand(
  commandWorkspaceId: string,
  actorUserId: string,
  email: string,
) {
  return {
    workspaceId: commandWorkspaceId,
    actorUserId,
    email,
    role: 'viewer' as const,
    idempotencyKey: randomUUID(),
    tokenDigest: invitationTokenDigest(randomUUID()),
    sealedToken: testSealedToken(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
  };
}

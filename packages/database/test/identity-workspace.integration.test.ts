import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  createOidcLoginTransactionStore,
  IdentityConflictError,
  IdentityNotFoundError,
  OidcTransactionCapacityError,
  parseDatabaseConfig,
  auditEvents,
  workspaceMemberships,
} from '../src/index.js';
import { migrateDatabase } from '../src/migrations.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const identityDatabase = createIdentityWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
);
const tenantDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
);
const oidcStore = createOidcLoginTransactionStore(
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
            created_at)
         select md5($1 || series::text) || md5(series::text || $1),
                'sealed-verifier', 'nonce', 'tag', 'test-v1',
                'sealed-nonce', 'nonce', 'tag', 'test-v1',
                ${variant.expiresAt}, ${variant.consumedAt}, ${variant.createdAt}
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
    await pool.end();
  }
}

async function clearOidcTransactions(): Promise<void> {
  await replaceOidcTransactions({});
}

function oidcTransaction() {
  return {
    stateDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    codeVerifier: `verifier-${randomUUID()}`,
    nonce: `nonce-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
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
  await identityDatabase.close();
  await tenantDatabase.close();
  await oidcStore.close();
});

describe('identity/workspace persistence', () => {
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

  it('rolls back deletion state and session changes when audit facts are unsafe', async () => {
    const digest = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.createSession({
      userId: ownerUserId,
      tokenDigest: digest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      identityDatabase.requestWorkspaceDeletion(
        workspaceId,
        ownerUserId,
        new Date(Date.now() + 60_000),
        'rollback test',
        { metadata: { token: 'forbidden' } },
      ),
    ).rejects.toThrow('Unsafe audit metadata key');
    await expect(
      identityDatabase.findWorkspaceAccess(ownerUserId, workspaceId),
    ).resolves.toMatchObject({ workspaceStatus: 'active' });
    await expect(
      identityDatabase.findActiveSessionByDigest(digest),
    ).resolves.not.toBeNull();
  });

  it('revokes member sessions atomically and restores to suspended', async () => {
    const extraSession = await identityDatabase.createSession({
      userId: ownerUserId,
      tokenDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await identityDatabase.requestWorkspaceDeletion(
      workspaceId,
      ownerUserId,
      new Date(Date.now() + 60_000),
      'customer requested deletion',
      { requestId: 'delete-request' },
    );
    expect(result.workspace.status).toBe('pending_deletion');
    expect(result.workspace.deletionReason).toBe('customer requested deletion');
    expect(result.revokedSessionCount).toBeGreaterThanOrEqual(1);
    expect(
      await identityDatabase.findActiveSessionByDigest(
        extraSession.tokenDigest,
      ),
    ).toBeNull();

    const restored = await identityDatabase.restoreWorkspace(
      workspaceId,
      ownerUserId,
      {
        requestId: 'restore-request',
      },
    );
    expect(restored.workspace.status).toBe('suspended');
    expect(restored.workspace.deletionReason).toBeNull();
    await expect(
      identityDatabase.restoreWorkspace(workspaceId, ownerUserId),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
    const repeatedDeletion = await identityDatabase.requestWorkspaceDeletion(
      workspaceId,
      ownerUserId,
      new Date(Date.now() + 60_000),
      'delete after suspended restore',
    );
    expect(repeatedDeletion.workspace.status).toBe('pending_deletion');
    await expect(
      identityDatabase.restoreWorkspace(workspaceId, ownerUserId),
    ).resolves.toMatchObject({ workspace: { status: 'suspended' } });
    const events = await tenantDatabase.withWorkspace(
      workspaceId,
      async ({ db }) =>
        db.select({ action: auditEvents.action }).from(auditEvents),
    );
    expect(events.map((event) => event.action)).toEqual([
      'workspace.created',
      'workspace.deletion_requested',
      'workspace.restored',
      'workspace.deletion_requested',
      'workspace.restored',
    ]);
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
    ).rejects.toBeInstanceOf(Error);
    const emailPool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const users = await emailPool.query<{ count: string }>(
        'select count(*)::text as count from app.users where lower(email) = lower($1)',
        [sameEmail],
      );
      expect(separateA.user.id).toBeTruthy();
      expect(users.rows[0]?.count).toBe('1');
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
    const expiresAt = new Date(Date.now() + 60_000);
    await oidcStore.create({ stateDigest, codeVerifier, nonce, expiresAt });
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
    const [first, second] = await Promise.all([
      oidcStore.consume(stateDigest, new Date()),
      oidcStore.consume(stateDigest, new Date()),
    ]);
    expect([first.status, second.status].sort()).toEqual(['ok', 'replayed']);
    const successful = first.status === 'ok' ? first : second;
    expect(successful.transaction?.codeVerifier).toBe(codeVerifier);
    expect(successful.transaction?.nonce).toBe(nonce);
    expect((await oidcStore.consume(stateDigest, new Date())).status).toBe(
      'replayed',
    );

    const expiredDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await oidcStore.create({
      stateDigest: expiredDigest,
      codeVerifier,
      nonce,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      (await oidcStore.consume(expiredDigest, new Date(Date.now() + 120_000)))
        .status,
    ).toBe('expired');
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

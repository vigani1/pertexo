import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactFinalizeConflictError,
  ArtifactLifecycleConflictError,
  claimDueUnfinalizedArtifact,
  claimDueUnfinalizedArtifacts,
  completeArtifactRemoval,
  createPendingArtifact,
  finalizeArtifactUpload,
  readArtifactCapacity,
} from '../src/artifacts.js';
import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { migrateDatabase } from '../src/migrations.js';
import { artifacts } from '../src/schema.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

const database = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
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

let workspaceA = randomUUID();
let workspaceB = randomUUID();

function pendingInput(overrides: Record<string, unknown> = {}) {
  const artifactId = randomUUID();
  return {
    artifactId,
    byteLength: 27,
    expiresAt: new Date(Date.now() + 300_000),
    mediaType: 'application/octet-stream',
    purpose: 'workflow-input',
    sha256: 'a'.repeat(64),
    storageKey: `workspaces/${workspaceA}/artifacts/${artifactId}`,
    ...overrides,
  };
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
});

beforeEach(() => {
  workspaceA = randomUUID();
  workspaceB = randomUUID();
});

afterAll(async () => {
  await database.close();
});

describe('artifact metadata lifecycle', () => {
  it('forces RLS and withholds destructive table privileges from serving roles', async () => {
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      const result = await client.query<{
        api_delete: boolean;
        api_truncate: boolean;
        api_update: boolean;
        api_update_status: boolean;
        relforcerowsecurity: boolean;
        relrowsecurity: boolean;
        worker_delete: boolean;
        worker_truncate: boolean;
        worker_update: boolean;
        worker_update_status: boolean;
      }>(`
        select
          table_class.relrowsecurity,
          table_class.relforcerowsecurity,
          has_table_privilege('pertexo_api', table_class.oid, 'DELETE') as api_delete,
          has_table_privilege('pertexo_api', table_class.oid, 'TRUNCATE') as api_truncate,
          has_table_privilege('pertexo_api', table_class.oid, 'UPDATE') as api_update,
          has_column_privilege('pertexo_api', table_class.oid, 'status', 'UPDATE') as api_update_status,
          has_table_privilege('pertexo_worker', table_class.oid, 'DELETE') as worker_delete,
          has_table_privilege('pertexo_worker', table_class.oid, 'TRUNCATE') as worker_truncate,
          has_table_privilege('pertexo_worker', table_class.oid, 'UPDATE') as worker_update,
          has_column_privilege('pertexo_worker', table_class.oid, 'status', 'UPDATE') as worker_update_status
        from pg_class table_class
        where table_class.oid = 'app.artifacts'::regclass
      `);
      expect(result.rows).toEqual([
        {
          api_delete: false,
          api_truncate: false,
          api_update: false,
          api_update_status: true,
          relforcerowsecurity: true,
          relrowsecurity: true,
          worker_delete: false,
          worker_truncate: false,
          worker_update: false,
          worker_update_status: true,
        },
      ]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  });

  it.each([
    ['API', apiUrl],
    ['worker', workerUrl],
  ])(
    'prevents the %s role from rewriting immutable artifact metadata',
    async (_role, connectionString) => {
      const input = pendingInput();
      await database.withWorkspace(workspaceA, (transaction) =>
        createPendingArtifact(transaction, input),
      );
      const pool = new Pool({ connectionString, max: 1 });
      const client = await pool.connect();
      try {
        await client.query(`select set_config('app.workspace_id', $1, false)`, [
          workspaceA,
        ]);
        await expect(
          client.query(`update app.artifacts set sha256 = $1 where id = $2`, [
            'b'.repeat(64),
            input.artifactId,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        client.release();
        await pool.end();
      }
    },
  );

  it('creates pending metadata that forced RLS hides from other workspaces', async () => {
    const input = pendingInput();
    const created = await database.withWorkspace(workspaceA, (transaction) =>
      createPendingArtifact(transaction, input),
    );

    expect(created).toMatchObject({
      byteLength: input.byteLength,
      expiresAt: input.expiresAt,
      id: input.artifactId,
      mediaType: input.mediaType,
      purpose: input.purpose,
      sha256: input.sha256,
      storageKey: input.storageKey,
      status: 'pending',
      workspaceId: workspaceA,
    });
    await expect(
      database.withWorkspace(workspaceB, ({ db }) =>
        db.select().from(artifacts).where(eq(artifacts.id, input.artifactId)),
      ),
    ).resolves.toEqual([]);
  });

  it('aggregates artifact count and bytes only inside the active workspace context', async () => {
    const pending = pendingInput({ byteLength: 27 });
    const available = pendingInput({ byteLength: 41 });
    const hidden = pendingInput({ byteLength: 59 });
    await database.withWorkspace(workspaceA, async (transaction) => {
      await createPendingArtifact(transaction, pending);
      await createPendingArtifact(transaction, available);
      await finalizeArtifactUpload(transaction, {
        artifactId: available.artifactId,
        byteLength: available.byteLength,
        mediaType: available.mediaType,
        sha256: available.sha256,
        storageKey: available.storageKey,
        workspaceId: workspaceA,
      });
    });
    await database.withWorkspace(workspaceB, (transaction) =>
      createPendingArtifact(transaction, {
        ...hidden,
        storageKey: `workspaces/${workspaceB}/artifacts/${hidden.artifactId}`,
      }),
    );

    await expect(
      database.withWorkspace(workspaceA, readArtifactCapacity),
    ).resolves.toEqual([
      { bytes: 41, count: 1, status: 'available' },
      { bytes: 0, count: 0, status: 'deleted' },
      { bytes: 0, count: 0, status: 'deleting' },
      { bytes: 27, count: 1, status: 'pending' },
    ]);
  });

  it('atomically finalizes exact validated metadata and treats an exact replay as idempotent', async () => {
    const input = pendingInput();
    await database.withWorkspace(workspaceA, (transaction) =>
      createPendingArtifact(transaction, input),
    );
    const validation = {
      artifactId: input.artifactId,
      byteLength: input.byteLength,
      mediaType: input.mediaType,
      sha256: input.sha256,
      storageKey: input.storageKey,
      workspaceId: workspaceA,
    };

    const finalized = await database.withWorkspace(workspaceA, (transaction) =>
      finalizeArtifactUpload(transaction, validation),
    );
    const replayed = await database.withWorkspace(workspaceA, (transaction) =>
      finalizeArtifactUpload(transaction, validation),
    );

    expect(finalized.status).toBe('available');
    expect(finalized.finalizedAt).toBeInstanceOf(Date);
    expect(replayed).toEqual(finalized);
    await expect(
      database.withWorkspace(workspaceA, (transaction) =>
        finalizeArtifactUpload(transaction, {
          ...validation,
          sha256: 'b'.repeat(64),
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactFinalizeConflictError);
  });

  it.each([
    ['workspaceId', workspaceB],
    ['byteLength', 28],
    ['mediaType', 'text/plain'],
    ['sha256', 'b'.repeat(64)],
    ['storageKey', `workspaces/${workspaceA}/artifacts/${randomUUID()}`],
  ])('rejects finalize when validated %s differs', async (field, value) => {
    const input = pendingInput();
    await database.withWorkspace(workspaceA, (transaction) =>
      createPendingArtifact(transaction, input),
    );

    await expect(
      database.withWorkspace(workspaceA, (transaction) =>
        finalizeArtifactUpload(transaction, {
          artifactId: input.artifactId,
          byteLength: input.byteLength,
          mediaType: input.mediaType,
          sha256: input.sha256,
          storageKey: input.storageKey,
          workspaceId: workspaceA,
          [field]: value,
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactFinalizeConflictError);
  });

  it('rejects a late finalize after pending metadata has expired', async () => {
    const input = pendingInput({ expiresAt: new Date(Date.now() - 1_000) });
    await database.withWorkspace(workspaceA, (transaction) =>
      createPendingArtifact(transaction, input),
    );

    await expect(
      database.withWorkspace(workspaceA, (transaction) =>
        finalizeArtifactUpload(transaction, {
          artifactId: input.artifactId,
          byteLength: input.byteLength,
          mediaType: input.mediaType,
          sha256: input.sha256,
          storageKey: input.storageKey,
          workspaceId: workspaceA,
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactLifecycleConflictError);
  });

  it('claims only due pending uploads and completes metadata removal', async () => {
    const due = pendingInput({ expiresAt: new Date(Date.now() - 60_000) });
    const future = pendingInput();
    const available = pendingInput();
    await database.withWorkspace(workspaceA, async (transaction) => {
      await createPendingArtifact(transaction, due);
      await createPendingArtifact(transaction, future);
      await createPendingArtifact(transaction, available);
      await finalizeArtifactUpload(transaction, {
        artifactId: available.artifactId,
        byteLength: available.byteLength,
        mediaType: available.mediaType,
        sha256: available.sha256,
        storageKey: available.storageKey,
        workspaceId: workspaceA,
      });
    });

    const claimed = await database.withWorkspace(workspaceA, (transaction) =>
      claimDueUnfinalizedArtifacts(transaction, {
        limit: 10,
      }),
    );
    expect(claimed.map((artifact) => artifact.id)).toEqual([due.artifactId]);
    expect(claimed[0]?.status).toBe('deleting');
    const resumed = await database.withWorkspace(workspaceA, (transaction) =>
      claimDueUnfinalizedArtifact(transaction, {
        artifactId: due.artifactId,
      }),
    );
    expect(resumed.status).toBe('deleting');

    const deleted = await database.withWorkspace(workspaceA, (transaction) =>
      completeArtifactRemoval(transaction, { artifactId: due.artifactId }),
    );
    expect(deleted.status).toBe('deleted');
    expect(deleted.deletedAt).toBeInstanceOf(Date);
  });

  it('uses skip-locked claims so concurrent maintenance batches are disjoint', async () => {
    const due = Array.from({ length: 4 }, () =>
      pendingInput({ expiresAt: new Date(Date.now() - 60_000) }),
    );
    await database.withWorkspace(workspaceA, async (transaction) => {
      for (const input of due) await createPendingArtifact(transaction, input);
    });

    const [left, right] = await Promise.all([
      database.withWorkspace(workspaceA, (transaction) =>
        claimDueUnfinalizedArtifacts(transaction, {
          limit: 2,
        }),
      ),
      database.withWorkspace(workspaceA, (transaction) =>
        claimDueUnfinalizedArtifacts(transaction, {
          limit: 2,
        }),
      ),
    ]);
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect(
      new Set([...left, ...right].map((artifact) => artifact.id)).size,
    ).toBe(4);
  });
});

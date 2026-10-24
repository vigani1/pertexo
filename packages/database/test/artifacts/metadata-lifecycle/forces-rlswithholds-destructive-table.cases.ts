import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {ArtifactFinalizeConflictError} from '../../../src/artifacts/input.js';
import {createPendingArtifact, finalizeArtifactUpload} from '../../../src/artifacts/repository.js';
import {readArtifactCapacity} from '../../../src/artifacts/capacity.queries.js';

import { artifacts } from '../../../src/schema.js';

import {
  migrationUrl,
  apiUrl,
  workerUrl,
  database,
  workspaceA,
  workspaceB,
  pendingInput,
} from './fixture.js';

export function registerForcesRLSWithholdsDestructiveTable(): void {
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
          has_table_privilege('pertexo_app', table_class.oid, 'DELETE') as api_delete,
          has_table_privilege('pertexo_app', table_class.oid, 'TRUNCATE') as api_truncate,
          has_table_privilege('pertexo_app', table_class.oid, 'UPDATE') as api_update,
          has_column_privilege('pertexo_app', table_class.oid, 'status', 'UPDATE') as api_update_status,
          has_table_privilege('pertexo_app', table_class.oid, 'DELETE') as worker_delete,
          has_table_privilege('pertexo_app', table_class.oid, 'TRUNCATE') as worker_truncate,
          has_table_privilege('pertexo_app', table_class.oid, 'UPDATE') as worker_update,
          has_column_privilege('pertexo_app', table_class.oid, 'status', 'UPDATE') as worker_update_status
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
}

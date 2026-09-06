import { describe, expect, it, vi } from 'vitest';

import {
  type ControlLedger,
  Pool,
  adminUrl,
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  migrationUrl,
  owner,
  parseDatabaseConfig,
  randomUUID,
  runIds,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
  zeroHash,
} from './support/retention.integration.support.js';

async function readCapacity(): Promise<{
  chargedBytes: number;
  chargedCount: number;
}> {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await owner.query<{
      charged_bytes: number | string;
      charged_count: number;
    }>(
      `select charged_bytes,charged_count
         from app.workspace_artifact_capacity where workspace_id=$1`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('artifact capacity row missing');
    await owner.query('commit');
    return {
      chargedBytes: Number(row.charged_bytes),
      chargedCount: row.charged_count,
    };
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

describe('retention artifact reclamation', () => {
  it('retains referenced artifacts and deletes unreferenced bytes before metadata', async () => {
    const coordinatorApplication = `retention-artifacts-${workspaceId}`;
    const referencedArtifactId = '00000000-0000-4000-8000-000000000101';
    const expiredArtifactId = '00000000-0000-4000-8000-000000000102';
    const followingArtifactId = '00000000-0000-4000-8000-000000000103';
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.artifacts no force row level security',
      );
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      for (const artifactId of [
        referencedArtifactId,
        expiredArtifactId,
        followingArtifactId,
      ]) {
        await owner.query(
          `insert into app.artifacts
            (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at)
           values($1,$2,'node-output',$3,'application/json',10,$4,
             'available','2026-07-01T00:00:00Z','2026-06-01T00:00:00Z')`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'a'.repeat(64),
          ],
        );
      }
      await owner.query(
        `update app.workflow_runs set output_ref=$2::jsonb where id=$1`,
        [
          runIds[3],
          JSON.stringify({
            artifactId: referencedArtifactId,
            kind: 'artifact',
            schemaVersion: 1,
          }),
        ],
      );
      await owner.query('alter table app.artifacts force row level security');
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 30,
      chargedCount: 3,
    });

    const ledger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: zeroHash,
          pageEndSequence: 0,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
    let releaseDelete: (() => void) | undefined;
    const deleteStarted = Promise.withResolvers<undefined>();
    const artifacts = {
      delete: vi
        .fn(() => Promise.resolve())
        .mockImplementationOnce(() => Promise.resolve())
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseDelete = resolve;
              deleteStarted.resolve(undefined);
            }),
        ),
      head: vi
        .fn()
        .mockResolvedValueOnce({ stillPresent: true })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          maintenanceUrl,
          coordinatorApplication,
        ),
        max: 2,
      }),
      ledger,
      artifacts,
    );
    try {
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: referencedArtifactId,
        status: 'referenced',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 30,
        chargedCount: 3,
      });
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: expiredArtifactId,
        status: 'waiting',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 30,
        chargedCount: 3,
      });
      const writer = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await writer.query('begin');
        await writer.query('set local role pertexo_owner');
        await writer.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await writer.query(
          'update app.workflow_runs set output_ref=$2::jsonb where id=$1',
          [
            runIds[3],
            JSON.stringify({
              artifactId: followingArtifactId,
              kind: 'artifact',
              schemaVersion: 1,
            }),
          ],
        );
        let settled = false;
        const following = coordinator.processNext().then((result) => {
          settled = true;
          return result;
        });
        await waitForPostgresLock(coordinatorApplication);
        expect(settled).toBe(false);
        await writer.query('rollback');
        await deleteStarted.promise;
        await expect(readCapacity()).resolves.toEqual({
          chargedBytes: 30,
          chargedCount: 3,
        });
        const monitor = new Pool({ connectionString: adminUrl, max: 1 });
        try {
          const transaction = await monitor.query<{ open: boolean }>(
            `select exists (
               select 1 from pg_stat_activity
                where application_name=$1 and xact_start is not null
             ) open`,
            [coordinatorApplication],
          );
          expect(transaction.rows[0]).toEqual({ open: false });
        } finally {
          await monitor.end();
          releaseDelete?.();
        }
        await expect(following).resolves.toMatchObject({
          artifactId: followingArtifactId,
          status: 'completed',
        });
        await expect(readCapacity()).resolves.toEqual({
          chargedBytes: 20,
          chargedCount: 2,
        });
      } finally {
        await writer.query('rollback').catch(() => undefined);
        await writer.end();
      }
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await owner.query(
          `update app.artifacts set retention_retry_at=clock_timestamp()-interval '1 second'
           where id=$1`,
          [expiredArtifactId],
        );
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: expiredArtifactId,
        status: 'completed',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 10,
        chargedCount: 1,
      });
      expect(artifacts.delete).toHaveBeenCalledTimes(3);
    } finally {
      releaseDelete?.();
      await coordinator.close();
    }

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.artifacts no force row level security',
      );
      const proof = await owner.query(
        `select id,retention_retry_at is not null retry_scheduled
         from app.artifacts where id=any($1::uuid[]) order by id`,
        [[referencedArtifactId, expiredArtifactId, followingArtifactId]],
      );
      expect(proof.rows).toEqual([
        { id: referencedArtifactId, retry_scheduled: true },
      ]);
      await owner.query('alter table app.artifacts force row level security');
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });

  it('holds an expired user-upload artifact before any object-store operation', async () => {
    const artifactId = randomUUID();
    const holdId = randomUUID();
    const holdHash = 'b'.repeat(64);
    const before = await readCapacity();
    const apiUrl = new URL(
      process.env.DATABASE_API_URL ??
        'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
    );
    apiUrl.pathname = new URL(maintenanceUrl).pathname;
    const api = new Pool({ connectionString: apiUrl.toString(), max: 1 });
    const maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });

    try {
      await api.query('begin');
      try {
        await api.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await api.query(
          `insert into app.artifacts
             (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
              status,expires_at,finalized_at)
           values($1,$2,'user-upload',$3,'application/octet-stream',10,$4,
             'available',clock_timestamp()-interval '1 hour',
             clock_timestamp()-interval '2 hours')`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'c'.repeat(64),
          ],
        );
        await api.query('commit');
      } catch (error: unknown) {
        await api.query('rollback').catch(() => undefined);
        throw error;
      }

      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });

      await maintenance.query(
        `select app.project_workspace_legal_hold(
          $1,1,$2,'legal_hold_placed',$3,$4,$5,
          'legal-admin','case-artifact-1','preserve user-upload',$6)`,
        [
          workspaceId,
          randomUUID(),
          holdId,
          zeroHash,
          holdHash,
          '2026-08-21T00:00:00.000Z',
        ],
      );

      const ledger = {
        append: vi.fn(),
        reconcile: vi.fn(() =>
          Promise.resolve({
            hasMore: false,
            pageEndHash: holdHash,
            pageEndSequence: 1,
            reachedHighWater: true,
            records: [],
          }),
        ),
      } satisfies ControlLedger;
      const artifacts = {
        delete: vi.fn(() => Promise.resolve()),
        head: vi.fn(() => Promise.resolve(null)),
      };
      const coordinator = createRunArtifactRetentionCoordinator(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
        ledger,
        artifacts,
      );
      try {
        await expect(coordinator.processNext()).resolves.toMatchObject({
          artifactId,
          status: 'held',
          workspaceId,
        });
      } finally {
        await coordinator.close();
      }

      expect(artifacts.delete).not.toHaveBeenCalled();
      expect(artifacts.head).not.toHaveBeenCalled();
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });

      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const proof = await owner.query(
          `select status,purpose,byte_length::text as byte_length,
                  retention_retry_at is not null as retry_scheduled
             from app.artifacts where workspace_id=$1 and id=$2`,
          [workspaceId, artifactId],
        );
        expect(proof.rows).toEqual([
          {
            byte_length: '10',
            purpose: 'user-upload',
            retry_scheduled: true,
            status: 'available',
          },
        ]);
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }
    } finally {
      await maintenance.end();
      await api.end();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  type ControlLedger,
  Pool,
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  migrationUrl,
  owner,
  parseDatabaseConfig,
  runIds,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
  zeroHash,
} from './support/retention.integration.support.js';

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
    const artifacts = {
      delete: vi.fn(() => Promise.resolve()),
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
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: expiredArtifactId,
        status: 'waiting',
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
        await expect(following).resolves.toMatchObject({
          artifactId: followingArtifactId,
          status: 'completed',
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
      expect(artifacts.delete).toHaveBeenCalledTimes(3);
    } finally {
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
});

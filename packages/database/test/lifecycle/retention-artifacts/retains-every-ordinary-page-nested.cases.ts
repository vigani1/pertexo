import { expect, it, vi } from 'vitest';

import {
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  parseDatabaseConfig,
  randomUUID,
  runIds,
  workspaceId,
} from '../retention.support.js';
import {
  readCapacity,
  withOwnerTransaction,
  insertExpiredPendingUserUpload,
  type ArtifactStoreInput,
} from './fixture.js';

export function registerRetainsEveryOrdinaryPageNested(): void {
  it('retains every ordinary page in a nested output bundle, then reclaims each physical file', async () => {
    const pages = [randomUUID(), randomUUID()].map((artifactId) => ({
      kind: 'artifact',
      artifactId,
      byteLength: 10,
      mediaType: 'application/json',
      sha256: 'a'.repeat(64),
    }));
    await withOwnerTransaction(async (client) => {
      for (const page of pages)
        await client.query(
          `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at) values($1,$2,'node-output',$3,$4,$5,$6,'available',clock_timestamp()-interval '1 day',clock_timestamp()-interval '2 days')`,
          [
            page.artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${page.artifactId}`,
            page.mediaType,
            page.byteLength,
            page.sha256,
          ],
        );
      await client.query(
        'update app.workflow_runs set output_ref=$2::json where id=$1',
        [
          runIds[3],
          JSON.stringify({
            kind: 'inline',
            value: { result: { pages, itemCount: 2, pageCount: 2 } },
          }),
        ],
      );
    });
    const store = {
      delete: vi.fn(() => Promise.resolve()),
      head: vi.fn(() => Promise.resolve(null)),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      store,
    );
    try {
      const retained = [];
      for (const _page of pages) retained.push(await coordinator.processNext());
      for (const page of pages)
        expect(retained).toContainEqual(
          expect.objectContaining({
            artifactId: page.artifactId,
            status: 'referenced',
          }),
        );
      expect(store.delete).not.toHaveBeenCalled();
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 20,
        chargedCount: 2,
      });
      await withOwnerTransaction(async (client) => {
        await client.query(
          'update app.workflow_runs set output_ref=null where id=$1',
          [runIds[3]],
        );
        await client.query(
          'update app.artifacts set retention_retry_at=null where workspace_id=$1',
          [workspaceId],
        );
      });
      for (const _page of pages)
        expect(await coordinator.processNext()).toMatchObject({
          status: 'completed',
        });
      expect(store.delete).toHaveBeenCalledTimes(2);
      for (const page of pages)
        expect(store.delete).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceId, artifactId: page.artifactId }),
        );
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 0,
        chargedCount: 0,
      });
    } finally {
      await coordinator.close();
    }
  });

  it('deletes expired pending user uploads before releasing capacity', async () => {
    const artifactId = randomUUID();
    await insertExpiredPendingUserUpload(artifactId, 'd');

    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 10,
      chargedCount: 1,
    });
    const artifacts = {
      delete: vi.fn((_input: ArtifactStoreInput) => {
        return Promise.resolve();
      }),
      head: vi.fn((_input: ArtifactStoreInput) => {
        return Promise.resolve(null);
      }),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      artifacts,
    );
    try {
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId,
        status: 'completed',
        workspaceId,
      });
    } finally {
      await coordinator.close();
    }

    expect(artifacts.delete).toHaveBeenCalledOnce();
    expect(artifacts.delete.mock.calls[0]?.[0]).toMatchObject({
      artifactId,
      workspaceId,
    });
    expect(artifacts.head).toHaveBeenCalledOnce();
    expect(artifacts.head.mock.calls[0]?.[0]).toMatchObject({
      artifactId,
      workspaceId,
    });
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 0,
      chargedCount: 0,
    });
  });
}

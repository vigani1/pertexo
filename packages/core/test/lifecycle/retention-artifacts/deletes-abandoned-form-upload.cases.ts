import { expect, it, vi } from 'vitest';

import {
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  parseDatabaseConfig,
  randomUUID,
  workspaceId,
} from '../retention.support.js';
import { readCapacity, withOwnerTransaction } from './fixture.js';

export function registerDeletesAbandonedFormUpload(): void {
  it('deletes an abandoned form upload with its response binding and releases its charge', async () => {
    const artifactId = randomUUID();
    const before = await readCapacity();
    await withOwnerTransaction(async (client) => {
      await client.query(
        `insert into app.artifacts
           (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
            status,expires_at)
         values($1,$2,'form-upload',$3,'application/pdf',10,$4,
           'pending',clock_timestamp()-interval '1 minute')`,
        [
          artifactId,
          workspaceId,
          `workspaces/${workspaceId}/artifacts/${artifactId}`,
          'f'.repeat(64),
        ],
      );
      await client.query(
        `insert into app.form_uploads
           (workspace_id,artifact_id,workflow_id,workflow_version_id,field_id,
            filename,session_hash,capability_hash)
         values($1,$2,$3,$4,'invoice','invoice.pdf',$5,$6)`,
        [
          workspaceId,
          artifactId,
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          'b'.repeat(64),
        ],
      );
    });
    const artifacts = {
      delete: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      artifacts,
    );
    try {
      await expect(coordinator.processNext()).resolves.toEqual({
        artifactId,
        status: 'completed',
        workspaceId,
      });
    } finally {
      await coordinator.close();
    }
    expect(artifacts.delete).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId, workspaceId }),
    );
    const remaining = await withOwnerTransaction((client) =>
      client.query(
        `select (select count(*) from app.artifacts where id=$1)::int artifacts,
                (select count(*) from app.form_uploads where artifact_id=$1)::int bindings`,
        [artifactId],
      ),
    );
    expect(remaining.rows[0]).toEqual({ artifacts: 0, bindings: 0 });
    await expect(readCapacity()).resolves.toEqual(before);
  });
}

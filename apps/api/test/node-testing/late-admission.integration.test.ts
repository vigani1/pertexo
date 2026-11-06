import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreviewRunStore } from '@pertexo/core/testing';
import { createArtifactTransferApiFixture } from '../artifacts/transfer-fixture/create.js';
import { artifactTransferIntegrationEnabled } from '../artifacts/transfer-fixture/environment.js';
import { nodeTestingFailure } from '../../src/problems/context/normalize.js';
import { toProblem } from '../../src/problems/registry.js';

// This crosses the real late core admission, after an earlier draft snapshot,
// then the same normalization/registry used by the node-testing controller.
describe.skipIf(!artifactTransferIntegrationEnabled)(
  'late step-test admission failures',
  () => {
    let fixture: Awaited<ReturnType<typeof createArtifactTransferApiFixture>>;
    let pool: Pool;
    const workflowId = randomUUID();
    beforeAll(async () => {
      fixture = await createArtifactTransferApiFixture();
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      await fixture.withOwner(async (client) => {
        await client.query(
          "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Concurrent draft',$3)",
          [workflowId, fixture.workspaceId, fixture.ownerUserId],
        );
        await client.query(
          'insert into app.workflow_drafts(workspace_id,workflow_id,revision,graph_json,updated_by) values($1,$2,2,\'{"nodes":[],"edges":[],"settings":{}}\'::json,$3)',
          [fixture.workspaceId, workflowId, fixture.ownerUserId],
        );
      });
    });
    afterAll(async () => {
      await pool.end();
      await fixture.close();
    });

    function accept() {
      return createPreviewRunStore(pool).acceptPreview({
        workspaceId: fixture.workspaceId,
        actorUserId: fixture.ownerUserId,
        workflowId,
        draftRevision: 1,
        draftFingerprint: 'a'.repeat(64),
        definitionKey: 'core.set',
        definitionVersion: 1,
        nodeId: 'step',
        executableNode: { id: 'step', type: 'core.set' },
        executorKey: 'core.set',
        executorVersion: 1,
        dryRun: 'not_supported',
        mayContactProvider: false,
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
        input: { kind: 'manual', value: {} },
        keyHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        requestHash: 'b'.repeat(64),
        scope: `workflow:${workflowId}:step`,
        operation: 'preview.execute',
        executionDeadlineAt: new Date(Date.now() + 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }
    it('returns the draft conflict and refresh/reprepare instruction when a newer save wins admission', async () => {
      const failure = await accept().catch((error: unknown) => error);
      expect(toProblem(nodeTestingFailure(failure))).toMatchObject({
        code: 'workflow.revision_conflict',
        safeDetail:
          'The saved draft changed. Refresh the draft and prepare the step test again.',
      });
      await fixture.withOwner(async (client) => {
        expect(
          (
            await client.query(
              'select revision::int from app.workflow_drafts where workflow_id=$1',
              [workflowId],
            )
          ).rows,
        ).toEqual([{ revision: 2 }]);
        expect(
          (
            await client.query(
              'select id from app.preview_runs where workflow_id=$1',
              [workflowId],
            )
          ).rows,
        ).toEqual([]);
      });
    });
    it('hides late workflow authority loss instead of treating it as a stale draft', async () => {
      await fixture.withOwner((client) =>
        client.query(
          "update app.workflows set lifecycle_status='archived' where id=$1",
          [workflowId],
        ),
      );
      expect(
        toProblem(
          nodeTestingFailure(await accept().catch((error: unknown) => error)),
        ),
      ).toMatchObject({ code: 'resource.not_found' });
    });
  },
);

import { waitForApplicationLock } from '../../support/postgres/lock-coordination.js';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { createCheckpoint } from '@pertexo/workflow-engine';

import { parseDatabaseConfig } from '@pertexo/database/platform';

import { RunVariableSnapshotUnavailableError } from '../../../src/runs/commands/variables.repository.js';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import { createRetentionStore } from '../../../src/lifecycle/retention/store.js';
import { admin } from '../../lifecycle/calls/fixtures.js';
import { maintenanceUrl, userId } from '../../lifecycle/retention.support.js';
import {
  config,
  admissionApplication,
  store,
  pool,
  fixture,
  scope,
  hash,
  admit,
  snapshot,
} from './fixture.js';

export function registerCapturesCoherentSetAfterConcurrent(): void {
  it.each(['commit', 'rollback'] as const)(
    'captures a coherent set after a concurrent edit %s and preserves exact retries',
    async (finish) => {
      const f = await fixture();
      await store.replace({
        ...scope(f.workspaceId),
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        values: { RATE: 10, CURRENCY: 'EUR' },
      });
      const writer = await pool.connect();
      let pending: ReturnType<typeof admit> | undefined;
      try {
        await writer.query('begin');
        await writer.query("select set_config('app.workspace_id',$1,true)", [
          f.workspaceId,
        ]);
        await writer.query(
          `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
      values($1,2,'{"RATE":20,"CURRENCY":"GBP"}')`,
          [f.workspaceId],
        );
        await writer.query(
          'update app.workspace_variables set revision=2 where workspace_id=$1',
          [f.workspaceId],
        );
        const key = hash();
        pending = admit(f, key);
        await waitForApplicationLock(admin, admissionApplication);
        expect((await store.read(scope(f.workspaceId))).values).toEqual({
          RATE: 10,
          CURRENCY: 'EUR',
        });
        await writer.query(finish);
        const first = await pending;
        const revision = finish === 'commit' ? 2 : 1;
        const values =
          finish === 'commit'
            ? { RATE: 20, CURRENCY: 'GBP' }
            : { RATE: 10, CURRENCY: 'EUR' };
        expect(await snapshot(first.runId)).toEqual({ revision, values });
        await store.replace({
          ...scope(f.workspaceId),
          idempotencyKey: randomUUID(),
          expectedRevision: revision,
          values: { RATE: 30, CURRENCY: 'USD' },
        });
        expect((await admit(f, key)).runId).toBe(first.runId);
        expect(await snapshot(first.runId)).toEqual({ revision, values });
        const next = await admit(f);
        expect(await snapshot(next.runId)).toEqual({
          revision: revision + 1,
          values: { RATE: 30, CURRENCY: 'USD' },
        });
      } finally {
        await writer.query('rollback');
        writer.release();
        await pending?.catch(() => undefined);
      }
    },
  );

  it('full replay retains the source snapshot after edits; logical detail expiry refuses even before cleanup', async () => {
    const f = await fixture();
    await store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { RATE: 10 },
    });
    const source = await admit(f);
    await store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { RATE: 20 },
    });
    const runs = createWorkflowRunDatabase(config());
    try {
      const command = {
        workspaceId: f.workspaceId,
        actorId: userId,
        sourceRunId: source.runId,
        workflowVersionId: f.parentVersionId,
        input: { vars: { RATE: 999 } },
        idempotencyKeyHash: hash(),
        requestHash: hash(),
        scope: `workflow:${f.parentWorkflowId}:replay`,
        checkpointFactory: (version: { id: string }) => ({
          checkpoint: createCheckpoint({
            workflowVersionId: version.id,
            iterationBudget: 200,
            nextEventSequence: 2,
          }),
        }),
      };
      const replay = await runs.replay(command);
      expect(await snapshot(replay.run.id)).toEqual({
        revision: 1,
        values: { RATE: 10 },
      });
      await admin.query(
        "update app.workflow_runs set status='succeeded',input_ref=null,input_ref_expires_at=null,created_at=clock_timestamp()-interval '32 days',completed_at=clock_timestamp()-interval '31 days' where id=$1",
        [source.runId],
      );
      expect(await snapshot(source.runId)).not.toBeNull();
      expect(
        await runs.readVariables({
          actorId: userId,
          workspaceId: f.workspaceId,
          runId: source.runId,
        }),
      ).toBeNull();
      await expect(
        runs.replay({
          ...command,
          idempotencyKeyHash: hash(),
          requestHash: hash(),
        }),
      ).rejects.toBeInstanceOf(RunVariableSnapshotUnavailableError);
      const retention = createRetentionStore(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
      );
      try {
        await retention.enforce();
        expect(
          (
            await admin.query(
              'select revision from app.workspace_variable_set_revisions where workspace_id=$1 order by revision',
              [f.workspaceId],
            )
          ).rows,
        ).toEqual([{ revision: 1 }, { revision: 2 }]);
        await admin.query(
          "update app.workflow_runs set status='succeeded',input_ref=null,input_ref_expires_at=null,created_at=clock_timestamp()-interval '32 days',completed_at=clock_timestamp()-interval '31 days' where id=$1",
          [replay.run.id],
        );
        await retention.enforce();
        expect(
          (
            await admin.query(
              'select revision from app.workspace_variable_set_revisions where workspace_id=$1 order by revision',
              [f.workspaceId],
            )
          ).rows,
        ).toEqual([{ revision: 2 }]);
      } finally {
        await retention.close();
      }
      expect(await snapshot(source.runId)).toBeNull();
    } finally {
      await runs.close();
    }
  });
}

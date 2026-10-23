import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  workspaceId,
  otherWorkspaceId,
  actorId,
  workflowId,
  workflowVersionId,
  owner,
  api,
  database,
  digest,
  startInput,
  ownerQuery,
  apiQuery,
} from './fixture.js';

export function registerKeepsReplayLocksBehindOwner(): void {
  it('keeps replay locks behind owner-defined reads and API insert-only grants', async () => {
    const source = await database.start(
      startInput(digest('lock-request'), digest('lock-key')),
    );

    await expect(
      apiQuery(`update app.workflow_runs set id=$2 where id=$1`, [
        source.run.id,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiQuery(`update app.workflow_versions set id=$2 where id=$1`, [
        workflowVersionId,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      apiQuery(`select * from app.lock_workflow_run_replay_source($1,$2)`, [
        otherWorkspaceId,
        source.run.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiQuery(`select * from app.lock_workflow_run_replay_version($1,$2,$3)`, [
        otherWorkspaceId,
        workflowId,
        workflowVersionId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiQuery(`select * from app.lock_workflow_run_replay_source($1,$2)`, [
        workspaceId,
        null,
      ]),
    ).rejects.toMatchObject({ code: '22023' });

    await expect(
      apiQuery(
        `select workflow_id,lifecycle_status
         from app.lock_workflow_run_replay_source($1,$2)`,
        [workspaceId, source.run.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ workflow_id: workflowId, lifecycle_status: 'active' }],
    });

    const lockClient = await owner.connect();
    const probeClient = await api.connect();
    try {
      await lockClient.query('begin');
      await lockClient.query('set local role pertexo_owner');
      await lockClient.query(`select set_config('app.workspace_id',$1,true)`, [
        workspaceId,
      ]);
      await lockClient.query(
        `select id from app.workflow_runs where id=$1 for update`,
        [source.run.id],
      );

      await probeClient.query('begin');
      await probeClient.query(`select set_config('app.workspace_id',$1,true)`, [
        workspaceId,
      ]);
      await probeClient.query(`set local statement_timeout='100ms'`);
      await expect(
        probeClient.query(
          `select * from app.lock_workflow_run_replay_source($1,$2)`,
          [workspaceId, source.run.id],
        ),
      ).rejects.toMatchObject({ code: '57014' });
      await probeClient.query('rollback');
      await lockClient.query('rollback');
    } finally {
      await probeClient.query('rollback').catch(() => undefined);
      probeClient.release();
      await lockClient.query('rollback').catch(() => undefined);
      lockClient.release();
    }
  });

  it('reads a run input as stored, absent, or past its 30-day window', async () => {
    const started = await database.start(startInput());
    await expect(
      database.readInput({
        actorId: actorId,
        workspaceId,
        runId: started.run.id,
      }),
    ).resolves.toEqual({
      kind: 'inline',
      value: { customerId: 'customer-42' },
    });
    await expect(
      database.readInput({
        actorId: actorId,
        workspaceId: otherWorkspaceId,
        runId: started.run.id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.readInput({
        actorId: actorId,
        workspaceId,
        runId: randomUUID(),
      }),
    ).resolves.toBeUndefined();

    await ownerQuery(
      `update app.workflow_runs
       set input_ref = null, input_ref_expires_at = null
       where id = $1`,
      [started.run.id],
    );
    await expect(
      database.readInput({
        actorId: actorId,
        workspaceId,
        runId: started.run.id,
      }),
    ).resolves.toEqual({ kind: 'none' });

    await ownerQuery(
      `update app.workflow_runs
       set created_at = created_at - interval '31 days',
           updated_at = updated_at - interval '31 days'
       where id = $1`,
      [started.run.id],
    );
    await expect(
      database.readInput({
        actorId: actorId,
        workspaceId,
        runId: started.run.id,
      }),
    ).resolves.toEqual({ kind: 'expired' });
  });
}

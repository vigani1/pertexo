import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('keeps populated event and checkpoint references safe without treating inline user JSON as dependencies', async () => {
  await withUpgradeDatabase(84, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const runId = randomUUID(),
      versionId = randomUUID();
    const client = await admin.connect();
    try {
      await client.query("select set_config('app.workspace_id',$1,false)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
         values($1,$2,$3,$4,'manual','failed')`,
        [runId, workspaceId, workflowId, versionId],
      );
      await client.query(
        `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
         values($1,$2,1,'run.started','{"retained":true}')`,
        [workspaceId, runId],
      );
      await client.query(
        `insert into app.run_checkpoints(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state)
         values($1,$2,$3,0,'{"retained":true}')`,
        [workspaceId, runId, versionId],
      );
      const rows = async () =>
        (
          await client.query<Record<string, unknown>>(
            `select payload,scheduler_state from app.run_events e join app.run_checkpoints c using(workflow_run_id)
         where e.workflow_run_id=$1`,
            [runId],
          )
        ).rows;
      const before = await rows();
      expect(await upgrade(85)).toEqual([
        '0085_execution_artifact_reference_coverage.sql',
      ]);
      expect(await rows()).toEqual(before);

      for (const artifactId of [
        randomUUID(),
        '11111111-1111-7111-8111-111111111111',
      ]) {
        const reference = { kind: 'artifact', artifactId };
        const descriptor = {
          ...reference,
          byteLength: 1,
          mediaType: 'text/plain',
          sha256: 'a'.repeat(64),
        };
        for (const value of [
          reference,
          { artifactProof: reference },
          { output: reference },
          { invocations: [{ output: reference }] },
          { joins: [{ ledger: [{ output: reference }] }] },
          { loops: [{ collection: reference }] },
          { output: { kind: 'inline', value: { file: descriptor } } },
          {
            invocations: [{ output: { kind: 'inline', value: [descriptor] } }],
          },
        ]) {
          for (const statement of [
            'update app.run_events set payload=$2::jsonb where workflow_run_id=$1',
            'update app.run_checkpoints set scheduler_state=$2::jsonb where workflow_run_id=$1',
          ]) {
            await expect(
              client.query(statement, [runId, JSON.stringify(value)]),
            ).rejects.toMatchObject({ code: '23503' });
          }
        }
        const inline = { kind: 'inline', value: { nested: [reference] } };
        for (const value of [
          inline,
          { output: inline },
          { invocations: [{ output: inline }] },
        ]) {
          await client.query(
            'update app.run_events set payload=$2::jsonb where workflow_run_id=$1',
            [runId, JSON.stringify(value)],
          );
          await client.query(
            'update app.run_checkpoints set scheduler_state=$2::jsonb where workflow_run_id=$1',
            [runId, JSON.stringify(value)],
          );
          expect(await rows()).toEqual([
            { payload: value, scheduler_state: value },
          ]);
        }
      }
    } finally {
      client.release();
    }
  });
});

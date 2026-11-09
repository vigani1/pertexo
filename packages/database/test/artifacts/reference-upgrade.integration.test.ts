import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  seedWorkflow,
  withDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('saves artifact-shaped user JSON after upgrading a populated run and still refuses missing real references', async () => {
  await withDatabase(async ({ admin: pool }) => {
    const { workspaceId, workflowId } = await seedWorkflow(pool);
    const admin = await pool.connect();
    try {
      await admin.query("select set_config('app.workspace_id',$1,false)", [
        workspaceId,
      ]);
      const runId = randomUUID();
      await admin.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at)
      values($1,$2,$3,$4,'manual','failed','{"kind":"inline","value":{"retained":true}}',clock_timestamp()+interval '1 day')`,
        [runId, workspaceId, workflowId, randomUUID()],
      );
      const read = async () =>
        (
          await admin.query<Record<string, unknown>>(
            'select input_ref from app.workflow_runs where id=$1',
            [runId],
          )
        ).rows;
      const before = await read();

      expect(await read()).toEqual(before);
      const artifact = { kind: 'artifact', artifactId: randomUUID() };
      const inline = { kind: 'inline', value: { nested: [artifact] } };
      await admin.query(
        'update app.workflow_runs set input_ref=$2::jsonb where id=$1',
        [runId, JSON.stringify(inline)],
      );
      expect(await read()).toEqual([{ input_ref: inline }]);
      for (const missing of [
        artifact,
        {
          kind: 'inline',
          value: {
            file: {
              ...artifact,
              byteLength: 4,
              mediaType: 'text/plain',
              sha256: 'a'.repeat(64),
            },
          },
        },
      ]) {
        await expect(
          admin.query(
            'update app.workflow_runs set input_ref=$2::jsonb where id=$1',
            [runId, JSON.stringify(missing)],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        expect(await read()).toEqual([{ input_ref: inline }]);
      }
      const artifactId = randomUUID();
      await admin.query(
        `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at)
        values($1,$2,'run-output',$3,'text/plain',4,$4,'available',clock_timestamp()+interval '1 day',clock_timestamp())`,
        [
          artifactId,
          workspaceId,
          `workspaces/${workspaceId}/artifacts/${artifactId}`,
          'a'.repeat(64),
        ],
      );
      const reference = {
        kind: 'artifact',
        artifactId,
        byteLength: 4,
        mediaType: 'text/plain',
        sha256: 'a'.repeat(64),
      };
      await admin.query('begin');
      try {
        await admin.query(
          'update app.workflow_runs set input_ref=$2::jsonb where id=$1',
          [runId, JSON.stringify(reference)],
        );
        const remover = await pool.connect();
        try {
          await remover.query('begin');
          await remover.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
          await remover.query("set local lock_timeout='100ms'");
          await expect(
            remover.query(
              "update app.artifacts set status='deleting' where id=$1",
              [artifactId],
            ),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await remover.query('rollback');
          remover.release();
        }
        await admin.query('commit');
        expect(await read()).toEqual([{ input_ref: reference }]);
      } finally {
        await admin.query('rollback');
      }
    } finally {
      admin.release();
    }
  });
});

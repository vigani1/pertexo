import { it, expect } from 'vitest';
import {
  asOwner,
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from '../fixtures.js';
import { generatePersistedId } from '@pertexo/database/platform';

export function registerEnforcesV4V7ArtifactReferences(): void {
  it('enforces v4 and v7 artifact references on every execution row surface', async () => {
    const availableV7 = generatePersistedId();
    const availableV4 = randomUUID();
    const deletingV7 = generatePersistedId();
    const wrongWorkspaceV7 = generatePersistedId();
    const missingV7 = generatePersistedId();
    expect([availableV7, deletingV7, wrongWorkspaceV7, missingV7]).toSatisfy(
      (values: string[]) => values.every((value) => value[14] === '7'),
    );
    const seedArtifact = (
      workspaceId: string,
      artifactId: string,
      status: string,
    ) =>
      asRuntime(workerBaseUrl, workspaceId, (client) =>
        client.query(
          `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/json',1,$4,
             $5,now()+interval '1 day',now())`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'd'.repeat(64),
            status,
          ],
        ),
      );
    await Promise.all([
      seedArtifact(workspaceA, availableV7, 'available'),
      seedArtifact(workspaceA, availableV4, 'available'),
      seedArtifact(workspaceA, deletingV7, 'deleting'),
      seedArtifact(workspaceB, wrongWorkspaceV7, 'available'),
    ]);

    const reference = (artifactId: string) => ({
      artifactId,
      byteLength: 1,
      kind: 'artifact',
      mediaType: 'application/json',
      sha256: 'd'.repeat(64),
    });
    const runId = await insertRun({
      inputRef: reference(availableV7),
      schedulerState: {
        ...checkpoint({ runStatus: 'running' }),
        artifactProof: reference(availableV7),
      },
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,input_ref,output_ref
         ) values ($1,$2,$3,'artifact-matrix','artifact-matrix','{}','running',
           'safe',$4::jsonb,$4::jsonb)`,
        [nodeRunId, workspaceA, runId, JSON.stringify(reference(availableV7))],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
           output_ref,reconciliation_ref
         ) values ($1,$2,$3,1,'running','safe',$4::jsonb,$4::jsonb)`,
        [
          attemptId,
          workspaceA,
          nodeRunId,
          JSON.stringify(reference(availableV7)),
        ],
      );
      await client.query(
        `insert into app.run_events (
           workspace_id,workflow_run_id,sequence,type,payload
         ) values ($1,$2,2,'run.started',$3::jsonb)`,
        [workspaceA, runId, JSON.stringify(reference(availableV7))],
      );
    });

    const updates = [
      `update app.workflow_runs set input_ref=$2::jsonb,
         input_ref_expires_at=created_at+interval '1 day',output_ref=$2::jsonb
       where id=$1`,
      `update app.run_events set payload=$2::jsonb
       where workflow_run_id=$1 and sequence=2`,
      `update app.run_checkpoints set scheduler_state=
         jsonb_set(scheduler_state,'{artifactProof}',$2::jsonb)
       where workflow_run_id=$1`,
      `update app.node_runs set input_ref=$2::jsonb,output_ref=$2::jsonb
       where id=$1`,
      `update app.node_attempts set output_ref=$2::jsonb,reconciliation_ref=$2::jsonb
       where id=$1`,
    ] as const;
    const targets = [runId, runId, runId, nodeRunId, attemptId] as const;

    await asOwner(workspaceA, async (client) => {
      for (const candidate of [availableV7, availableV4])
        for (const [index, statement] of updates.entries())
          await client.query(statement, [
            targets[index],
            JSON.stringify(reference(candidate)),
          ]);

      const ordinaryJson = JSON.stringify({
        artifactId: missingV7,
        kind: 'inline',
        nested: { value: true },
      });
      for (const [index, statement] of updates.entries())
        await client.query(statement, [targets[index], ordinaryJson]);
    });

    for (const candidate of [missingV7, deletingV7, wrongWorkspaceV7])
      for (const [index, statement] of updates.entries())
        await expect(
          asOwner(workspaceA, (client) =>
            client.query(statement, [
              targets[index],
              JSON.stringify(reference(candidate)),
            ]),
          ),
        ).rejects.toMatchObject({ code: '23503' });
  });
}

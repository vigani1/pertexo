import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ArtifactMetadataNotFoundError } from '../../../src/artifacts/artifact.errors.js';
import { visibleArtifactIds } from '../../../src/artifacts/references/access.repository.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import {
  actorId,
  api,
  database,
  workspaceId,
  workflowId,
  workflowVersionId,
  startInput,
  replayInput,
  checkpoint,
  ownerQuery,
  resetFixture,
  beforeAllFixture1,
  afterAllFixture2,
  apiQuery,
} from './runs-api.fixture.js';

beforeAll(beforeAllFixture1, 60_000);
beforeEach(resetFixture);
afterAll(afterAllFixture2);

it.each(['start', 'replay'] as const)(
  '%s refuses a restricted artifact without creating a readable owner',
  async (command) => {
    const source = await database.start(startInput());
    const hiddenWorkflowId = randomUUID();
    const hiddenRunId = randomUUID();
    const folderId = randomUUID();
    const artifact = {
      kind: 'artifact' as const,
      artifactId: randomUUID(),
      byteLength: 4,
      mediaType: 'application/octet-stream',
      sha256: 'a'.repeat(64),
    };
    await ownerQuery(
      "insert into app.workflow_folders(workspace_id,id,access_mode,name,name_key) values($1,$2,'restricted','Hidden','hidden')",
      [workspaceId, folderId],
    );
    await ownerQuery(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Hidden',$3)",
      [hiddenWorkflowId, workspaceId, actorId],
    );
    await ownerQuery(
      'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3)',
      [workspaceId, hiddenWorkflowId, folderId],
    );
    await ownerQuery(
      "insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at) values($1,$2,'run-output',$3,$4,4,$5,'available',clock_timestamp()+interval '1 day',clock_timestamp())",
      [
        artifact.artifactId,
        workspaceId,
        `workspaces/${workspaceId}/artifacts/${artifact.artifactId}`,
        artifact.mediaType,
        artifact.sha256,
      ],
    );
    await apiQuery(
      "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at,input_ref,input_ref_expires_at) values($1,$2,$3,$4,'manual','failed',clock_timestamp(),$5::jsonb,clock_timestamp()+interval '1 day')",
      [
        hiddenRunId,
        workspaceId,
        hiddenWorkflowId,
        workflowVersionId,
        JSON.stringify(artifact),
      ],
    );
    await apiQuery(
      'insert into app.run_checkpoints(workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state) values($1,$2,$3,0,$4::jsonb)',
      [
        hiddenRunId,
        workspaceId,
        workflowVersionId,
        JSON.stringify(checkpoint()),
      ],
    );
    await ownerQuery(
      "update app.workspace_memberships set role='operator' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
    );
    const visible = () =>
      withTenantScopedClient(api, { workspaceId }, (client) =>
        visibleArtifactIds(client, { workspaceId, actorId }, [
          artifact.artifactId,
        ]),
      );
    expect(
      await database.canRead({ workspaceId, actorId, runId: hiddenRunId }),
    ).toBe(false);
    expect([...(await visible())]).toEqual([]);
    await expect(
      command === 'start'
        ? database.start({ ...startInput(), input: { file: artifact } })
        : database.replay({
            ...replayInput(source.run.id),
            input: { file: artifact },
          }),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
    expect([...(await visible())]).toEqual([]);
    const rows = await ownerQuery(
      'select id from app.workflow_runs where workspace_id=$1 and workflow_id=$2 order by id',
      [workspaceId, workflowId],
    );
    expect(rows.rows).toEqual([{ id: source.run.id }]);
  },
);

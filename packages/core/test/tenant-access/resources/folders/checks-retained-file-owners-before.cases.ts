import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import { createArtifactUploadDatabase } from '../../../../src/artifacts/uploads/repository.js';
import { ArtifactMetadataNotFoundError } from '../../../../src/artifacts/input.js';

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  authoring,
  emptyGraph,
  draftNode,
  queryAsOwner,
  workspaceId,
  workflowId,
} from '../../../support/workflow-authoring.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';

import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';
import {
  builder,
  folderId,
  publicId,
  privateRun,
  folders,
  runs,
} from './fixture.js';

export function registerChecksRetainedFileOwnersBefore(): void {
  it('checks retained file owners before saving references and allows deliberate sharing through a readable workflow', async () => {
    const artifactId = randomUUID();
    const descriptor = {
      kind: 'artifact' as const,
      artifactId,
      byteLength: 4,
      mediaType: 'application/octet-stream',
      sha256: 'b'.repeat(64),
    };
    await queryAsOwner(
      `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at)
    values($1,$2,'http-response',$3,$4,4,$5,'available',clock_timestamp()+interval '29 days',clock_timestamp())`,
      [
        artifactId,
        workspaceId,
        `workspaces/${workspaceId}/artifacts/${artifactId}`,
        descriptor.mediaType,
        descriptor.sha256,
      ],
      workspaceId,
    );
    await queryAsOwner(
      `update app.workflow_runs set output_ref=$3 where workspace_id=$1 and id=$2`,
      [
        workspaceId,
        privateRun,
        JSON.stringify({ kind: 'inline', value: descriptor }),
      ],
      workspaceId,
    );
    const files = createArtifactUploadDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const metadata = (reader: string) =>
      files.getMetadata({
        actor: { workspaceId, actorId: reader },
        identity: { workspaceId, artifactId },
      });
    try {
      expect(await metadata(builder)).toBeNull();
      expect((await metadata(actorId))?.id).toBe(artifactId);
      await queryAsOwner(
        `update app.workflow_runs set input_ref_expires_at=clock_timestamp()-interval '2 days',created_at=clock_timestamp()-interval '32 days',started_at=clock_timestamp()-interval '31 days 1 minute',completed_at=clock_timestamp()-interval '31 days' where workspace_id=$1 and id=$2`,
        [workspaceId, privateRun],
        workspaceId,
      );
      expect(await metadata(actorId)).toBeNull();
      await queryAsOwner(
        `update app.workflow_runs set input_ref_expires_at=clock_timestamp()+interval '29 days',created_at=clock_timestamp()-interval '10 seconds',started_at=clock_timestamp()-interval '9 seconds',completed_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2`,
        [workspaceId, privateRun],
        workspaceId,
      );

      const draft = await authoring.getDraft(workspaceId, publicId, builder);
      if (draft === null) throw new Error('Public draft missing');
      const request = {
        workspaceId,
        workflowId: publicId,
        graphJson: {
          ...emptyGraph,
          nodes: [draftNode('file', { file: descriptor })],
        },
        expectedRevision: draft.revision,
        representationTag: workflowDraftRepresentationTag({
          workflowId: publicId,
          revision: draft.revision,
          graph: draft.graphJson,
          compatibilityFingerprint: draft.compatibility.fingerprint,
        }),
      };
      await expect(
        authoring.saveDraft({ ...request, actorId: builder }),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      expect(
        (await authoring.getDraft(workspaceId, publicId, actorId))?.revision,
      ).toBe(draft.revision);
      await authoring.saveDraft({ ...request, actorId });
      expect((await metadata(builder))?.id).toBe(artifactId);
      expect(
        await runs.canRead({
          workspaceId,
          actorId: builder,
          runId: privateRun,
        }),
      ).toBe(false);
    } finally {
      await files.close();
    }
  });

  it('uses only current linked directory groups and never revives grants after unlinking', async () => {
    const organizationId = randomUUID(),
      groupId = randomUUID(),
      directoryUserId = randomUUID();
    await queryAsOwner(
      "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Resource groups')",
      [organizationId, workspaceId],
      workspaceId,
    );
    await queryAsOwner(
      'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$2)',
      [workspaceId, organizationId],
      workspaceId,
    );
    await queryAsOwner(
      "insert into app.auth_directory_groups(id,organization_id,display_name) values($1,$2,'Builders')",
      [groupId, organizationId],
      workspaceId,
    );
    await queryAsOwner(
      "insert into app.auth_directory_users(id,organization_id,user_name,normalized_user_name,login_email,profile,user_id) values($1,$2,$3,$3,$3,'{}',$4)",
      [directoryUserId, organizationId, `${builder}@example.test`, builder],
      workspaceId,
    );
    await queryAsOwner(
      'insert into app.auth_directory_group_members(organization_id,group_id,directory_user_id) values($1,$2,$3)',
      [organizationId, groupId, directoryUserId],
      workspaceId,
    );
    const sharing = await folders.readSharing({
      workspaceId,
      actorId,
      folderId,
    });
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId,
      idempotencyKey: randomUUID(),
      request: {
        mode: 'restricted',
        expectedFolderRevision: sharing.revision,
        grants: [{ kind: 'group', organizationId, groupId, access: 'editor' }],
      },
    });
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).not.toBeNull();
    await queryAsOwner(
      'update app.auth_directory_users set active=false where id=$1',
      [directoryUserId],
      workspaceId,
    );
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).toBeNull();
    await queryAsOwner(
      'update app.auth_directory_users set active=true where id=$1',
      [directoryUserId],
      workspaceId,
    );
    await queryAsOwner(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [workspaceId, builder],
      workspaceId,
    );
    await expect(
      authoring.getDraft(workspaceId, workflowId, builder),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await queryAsOwner(
      "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
      [workspaceId, builder],
      workspaceId,
    );
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).not.toBeNull();
    await queryAsOwner(
      'delete from app.auth_organization_workspaces where workspace_id=$1',
      [workspaceId],
      workspaceId,
    );
    await queryAsOwner(
      'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$2)',
      [workspaceId, organizationId],
      workspaceId,
    );
    expect(
      (await folders.readSharing({ workspaceId, actorId, folderId })).grants,
    ).toEqual([]);
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).toBeNull();
  });
}

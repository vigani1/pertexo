import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  authoring,
  actorId,
  workspaceId,
  queryAsOwner,
  saveCurrentDraft,
  randomUUID,
  failAtWrite,
  WorkflowRevisionConflictError,
} from '../../support/workflow-authoring.js';
import {
  createRestoreFixture,
  restoreInput,
  graphWithDuration,
} from './version-restore/fixture.js';
import {
  openWorld,
  closeWorld,
  folders,
  hiddenFolderId,
  moveIntoFolder,
  builder,
  viewer,
} from './access/world.js';

beforeAll(openWorld);
afterAll(closeWorld);

function copies(source: string) {
  return queryAsOwner<{
    id: string;
    name: string;
    graph: unknown;
    folder_id: string | null;
    activation_status: string;
    published_version_id: string | null;
    triggers: number;
  }>(
    `select w.id,w.name,d.graph_json graph,s.folder_id,w.activation_status,w.published_version_id,
       (select count(*)::int from app.workflow_triggers where workflow_id=w.id) triggers
     from app.audit_events a join app.workflows w on w.id=a.target_id
     join app.workflow_drafts d on d.workflow_id=w.id
     left join app.workflow_organization_state s on s.workflow_id=w.id
     where a.action='workflow.duplicated' and a.metadata->>'sourceWorkflowId'=$1`,
    [source],
    workspaceId,
  );
}

describe('restore preserves displaced unpublished work', () => {
  it('creates exactly one disabled copy with the edits, folder and inherited permissions', async () => {
    const fixture = await createRestoreFixture('recovery-copy');
    await moveIntoFolder(fixture.workflowId, hiddenFolderId);
    const sharing = await folders.readSharing({
      workspaceId,
      actorId,
      folderId: hiddenFolderId,
    });
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId: hiddenFolderId,
      idempotencyKey: randomUUID(),
      request: {
        mode: 'restricted',
        expectedFolderRevision: sharing.revision,
        grants: [{ kind: 'member', userId: builder, access: 'editor' }],
      },
    });
    const input = await restoreInput(fixture);
    const result = await authoring.restoreWorkflowVersion(input);
    const saved = await copies(fixture.workflowId);
    expect(saved).toHaveLength(1);
    expect(result).toMatchObject({ recoveryCopyId: saved[0]?.id });
    expect(saved[0]).toMatchObject({
      graph: fixture.currentGraph,
      folder_id: hiddenFolderId,
      activation_status: 'inactive',
      published_version_id: null,
      triggers: 0,
    });
    expect(saved[0]?.name).toMatch(
      /^Restore recovery-copy \(unpublished draft, \d{4}-\d{2}-\d{2}\)$/u,
    );
    const id = saved[0]?.id;
    if (id === undefined) throw new Error('Expected a recovery copy');
    await expect(
      authoring.getDraft(workspaceId, id, builder),
    ).resolves.toMatchObject({ graphJson: fixture.currentGraph });
    await expect(
      authoring.getWorkflow(workspaceId, id, viewer),
    ).resolves.toBeNull();
    await expect(
      authoring.restoreWorkflowVersion(input),
    ).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
    expect(await copies(fixture.workflowId)).toHaveLength(1);
  });

  it.each(['published', 'restored'] as const)(
    'makes no copy when the draft already matches the %s version',
    async (kind) => {
      const fixture = await createRestoreFixture(`recovery-none-${kind}`);
      const graphJson =
        kind === 'published'
          ? graphWithDuration(1_000)
          : { ...graphWithDuration(1_000), settings: {} };
      await saveCurrentDraft(authoring, {
        workspaceId,
        actorId,
        workflowId: fixture.workflowId,
        expectedRevision: 3,
        graphJson,
      });
      expect(
        await authoring.restoreWorkflowVersion(await restoreInput(fixture)),
      ).toMatchObject({ recoveryCopyId: null });
      expect(await copies(fixture.workflowId)).toEqual([]);
    },
  );

  it('rolls the copy back when the restore fails after replacing the draft', async () => {
    const fixture = await createRestoreFixture('recovery-rollback');
    const fault = await failAtWrite({
      table: 'audit_events',
      operation: 'insert',
      when: `NEW.target_id='${fixture.workflowId}' and NEW.action='workflow.version_restored'`,
    });
    try {
      await expect(
        authoring.restoreWorkflowVersion(await restoreInput(fixture)),
      ).rejects.toThrow(fault.message);
    } finally {
      await fault.remove();
    }
    expect(await copies(fixture.workflowId)).toEqual([]);
    await expect(
      authoring.getDraft(workspaceId, fixture.workflowId, actorId),
    ).resolves.toMatchObject({ graphJson: fixture.currentGraph });
  });
});

import { expect, it } from 'vitest';
import {
  actorId,
  authoring,
  createHash,
  currentRepresentationTag,
  emptyGraph,
  otherWorkflowId,
  randomUUID,
  saveCurrentDraft,
  workflowId,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerListsImmutableVersionsBoundedDeterministic(): void {
  it('lists immutable versions with a bounded deterministic cursor', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-version-page-proof',
      name: 'Version page proof',
      workspaceId,
    });
    for (const [index, duration] of [undefined, 1_000, 2_000].entries()) {
      if (duration !== undefined) {
        await saveCurrentDraft(authoring, {
          actorId,
          expectedRevision: index,
          graphJson: {
            ...emptyGraph,
            settings: { maxRunDurationMs: duration },
          },
          workflowId: created.workflowId,
          workspaceId,
        });
      }
      await authoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
        ),
        idempotencyKey: `publish-version-page-${String(index + 1)}`,
        requestHash: createHash('sha256')
          .update(`version-page-${String(index + 1)}`)
          .digest('hex'),
        workflowId: created.workflowId,
        workspaceId,
      });
    }

    const first = await authoring.listVersions({
      actorId,
      limit: 2,
      workflowId: created.workflowId,
      workspaceId,
    });
    expect(first.items.map((version) => version.versionNumber)).toEqual([3, 2]);
    expect(first.nextCursor).toEqual({ beforeVersionNumber: 2 });
    const oldest = await authoring.listVersions({
      actorId,
      workflowId: created.workflowId,
      workspaceId,
      beforeVersionNumber: 2,
    });
    const oldVersion = oldest.items[0];
    if (oldVersion === undefined) throw new Error('Expected oldest version');
    await expect(
      authoring.listVersions({
        actorId,
        workflowId: created.workflowId,
        workspaceId,
        versionId: oldVersion.id,
      }),
    ).resolves.toMatchObject({ items: [oldVersion] });
    const exact = await authoring.listVersions({
      actorId,
      workflowId: created.workflowId,
      workspaceId,
      versionId: oldVersion.id,
    });
    expect(exact.items).toHaveLength(1);
    expect(exact.nextCursor).toBeUndefined();
    await expect(
      authoring.listVersions({
        actorId,
        workflowId,
        workspaceId,
        versionId: oldVersion.id,
      }),
    ).resolves.toEqual({ items: [] });
    await expect(
      authoring.listVersions({
        actorId,
        workflowId: created.workflowId,
        workspaceId,
        versionId: randomUUID(),
      }),
    ).resolves.toEqual({ items: [] });

    if (first.nextCursor === undefined)
      throw new Error('Expected version cursor');
    await expect(
      authoring.listVersions({
        actorId,
        beforeVersionNumber: first.nextCursor.beforeVersionNumber,
        limit: 2,
        workflowId: created.workflowId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ items: [{ versionNumber: 1 }] });
    await expect(
      authoring.listVersions({
        actorId,
        workflowId: otherWorkflowId,
        workspaceId,
      }),
    ).rejects.toThrow('Workflow is not visible');
  });
}

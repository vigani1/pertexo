import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  otherWorkspaceId,
  emptyGraph,
  queryAsOwner,
  saveCurrentDraft,
} from '../../../support/workflow-authoring.js';
import {
  database,
  scope,
  promotions,
  configure,
  published,
} from './fixture.js';

export function registerRetainsCanvasDocumentationPromotedDraft(): void {
  it('retains canvas documentation in the promoted draft and immutable publication', async () => {
    await configure();
    const notes = [
      {
        id: randomUUID(),
        text: '# Production instructions',
        position: { x: 80, y: 160 },
        size: { width: 320, height: 200 },
        color: 'teal' as const,
      },
    ];
    const selection = await published({ ...emptyGraph, notes });
    const preview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    const applied = await promotions().apply({
      ...scope(),
      selections: [selection],
      mode: 'publish',
      fingerprint: preview.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const item = applied.items[0];
    if (item?.publishedVersionId == null)
      throw new Error('Missing promoted publication');
    expect(
      (
        await database.getDraft(
          otherWorkspaceId,
          item.targetWorkflowId,
          actorId,
        )
      )?.graphJson.notes,
    ).toEqual(notes);
    expect(
      (
        await database.getVersion(
          otherWorkspaceId,
          item.targetWorkflowId,
          item.publishedVersionId,
          actorId,
        )
      )?.graphJson.notes,
    ).toEqual(notes);
  });

  it('serializes competing applies and rolls the entire reviewed batch back on a conflict', async () => {
    await configure();
    const first = await published(),
      second = await published();
    const review = await promotions().preview({
      ...scope(),
      selections: [first, second],
      mode: 'draft',
    });
    const command = {
      ...scope(),
      selections: [first, second],
      mode: 'draft' as const,
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
    };
    const competing = await Promise.allSettled([
      promotions().apply({ ...command, idempotencyKey: randomUUID() }),
      promotions().apply({ ...command, idempotencyKey: randomUUID() }),
    ]);
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const origins = await queryAsOwner<{
      workflow_id: string;
      draft_revision: number;
    }>(
      'select workflow_id,draft_revision from app.workflow_promotion_origins where workspace_id=$1 and source_workflow_id=any($2::uuid[])',
      [otherWorkspaceId, [first.workflowId, second.workflowId]],
      otherWorkspaceId,
    );
    expect(origins).toHaveLength(2);
    expect(origins.map((row) => row.draft_revision)).toEqual([1, 1]);
    const next = await promotions().preview({
      ...scope(),
      selections: [first, second],
      mode: 'draft',
    });
    const one = origins[0];
    if (one === undefined) throw new Error('Missing origin');
    await saveCurrentDraft(database, {
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: one.workflow_id,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 30000 } },
    });
    await expect(
      promotions().apply({
        ...command,
        idempotencyKey: randomUUID(),
        fingerprint: next.fingerprint,
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    const after = await queryAsOwner<{ draft_revision: number }>(
      'select draft_revision from app.workflow_promotion_origins where workspace_id=$1 and source_workflow_id=any($2::uuid[])',
      [otherWorkspaceId, [first.workflowId, second.workflowId]],
      otherWorkspaceId,
    );
    expect(after.map((row) => row.draft_revision)).toEqual([1, 1]);
  });

  it('does not silently adopt an unrelated workflow by name', async () => {
    await configure();
    const selection = await published();
    const source = await database.getWorkflow(
      workspaceId,
      selection.workflowId,
      actorId,
    );
    if (source === null) throw new Error('Missing source');
    await database.createWorkflow({
      workspaceId: otherWorkspaceId,
      actorId,
      name: source.name,
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const review = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    expect(review.compatible).toBe(false);
    expect(review.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'name', status: 'incompatible' }),
      ]),
    );
  });

  it('rechecks target membership on exact replay and keeps copies independent of source deletion', async () => {
    await configure();
    const selection = await published();
    const review = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    const command = {
      ...scope(),
      selections: [selection],
      mode: 'draft' as const,
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    };
    const result = await promotions().apply(command);
    await queryAsOwner(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [otherWorkspaceId, actorId],
      otherWorkspaceId,
    );
    try {
      await expect(promotions().apply(command)).rejects.toThrow('visible');
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [otherWorkspaceId, actorId],
        otherWorkspaceId,
      );
    }
    await queryAsOwner(
      'update app.workflows set published_version_id=null where workspace_id=$1 and id=$2',
      [workspaceId, selection.workflowId],
      workspaceId,
    );
    await queryAsOwner(
      'delete from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
      [workspaceId, selection.workflowId],
      workspaceId,
    );
    const item = result.items[0];
    if (item === undefined) throw new Error('Missing promoted workflow');
    expect(
      await database.getDraft(otherWorkspaceId, item.targetWorkflowId, actorId),
    ).not.toBeNull();
    expect(await promotions().apply(command)).toEqual({
      ...result,
      replayed: true,
    });
  });
}

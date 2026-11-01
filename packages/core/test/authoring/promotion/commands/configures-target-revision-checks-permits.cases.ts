import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  otherActorId,
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

export function registerConfiguresTargetRevisionChecksPermits(): void {
  it('configures a target with revision checks and permits an owner to clear it without target access', async () => {
    const initial = await promotions().settings(scope());
    const result = await promotions().setTarget({
      ...scope(),
      expectedRevision: initial.revision,
      expectedTargetWorkspaceId: initial.target?.workspaceId ?? null,
      targetWorkspaceId: otherWorkspaceId,
      idempotencyKey: randomUUID(),
    });
    await expect(
      promotions().setTarget({
        ...scope(),
        expectedRevision: initial.revision,
        expectedTargetWorkspaceId: initial.target?.workspaceId ?? null,
        targetWorkspaceId: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    await expect(
      promotions().settings({ ...scope(), actorId: otherActorId }),
    ).rejects.toThrow('visible');
    await queryAsOwner(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [otherWorkspaceId, actorId],
      otherWorkspaceId,
    );
    expect(await promotions().settings(scope())).toMatchObject({
      canConfigure: true,
      target: { status: 'unavailable' },
    });
    const cleared = await promotions().setTarget({
      ...scope(),
      expectedRevision: result.revision,
      expectedTargetWorkspaceId: otherWorkspaceId,
      targetWorkspaceId: null,
      idempotencyKey: randomUUID(),
    });
    expect(cleared.revision).toBe(result.revision + 1);
    await queryAsOwner(
      "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
      [otherWorkspaceId, actorId],
      otherWorkspaceId,
    );
  });

  it('applies an exact reviewed version once, records safe history, and protects direct target edits', async () => {
    await configure();
    const selection = await published();
    const preview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    expect(preview.compatible).toBe(true);
    expect(preview.workflows[0]).toMatchObject({
      targetWorkflowId: null,
      directChanges: false,
    });
    const command = {
      ...scope(),
      selections: [selection],
      mode: 'draft' as const,
      fingerprint: preview.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    };
    const applied = await promotions().apply(command);
    expect(await promotions().apply(command)).toEqual({
      ...applied,
      replayed: true,
    });
    const item = applied.items[0];
    if (item === undefined) throw new Error('Missing promoted workflow');
    expect(
      (
        await database.getDraft(
          otherWorkspaceId,
          item.targetWorkflowId,
          actorId,
        )
      )?.graphJson,
    ).toEqual(emptyGraph);
    expect(
      (await promotions().history({ ...scope(), limit: 20 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          promotionId: applied.promotionId,
          targetWorkflowId: item.targetWorkflowId,
        }),
      ]),
    );
    const cleanReview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    await saveCurrentDraft(database, {
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: item.targetWorkflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 60000 } },
    });
    await expect(
      promotions().apply({
        ...command,
        idempotencyKey: randomUUID(),
        fingerprint: cleanReview.fingerprint,
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    const changed = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    expect(changed.workflows[0]?.directChanges).toBe(true);
    await expect(
      promotions().apply({
        ...command,
        idempotencyKey: randomUUID(),
        fingerprint: changed.fingerprint,
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });
    await promotions().apply({
      ...command,
      idempotencyKey: randomUUID(),
      fingerprint: changed.fingerprint,
      acknowledgeTargetChanges: [selection.workflowId],
    });
  });

  it('publishes through the normal owner, retains correspondence, and refuses an F18 policy bypass', async () => {
    await configure();
    const selection = await published();
    const preview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    expect(preview.compatible).toBe(true);
    const applied = await promotions().apply({
      ...scope(),
      selections: [selection],
      mode: 'publish',
      fingerprint: preview.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const item = applied.items[0];
    if (item === undefined) throw new Error('Missing promoted workflow');
    expect(item.publishedVersionId).not.toBeNull();
    const facts = await queryAsOwner(
      'select source_workflow_id,source_version_id,version_id from app.workflow_version_promotions where workspace_id=$1 and workflow_id=$2',
      [otherWorkspaceId, item.targetWorkflowId],
      otherWorkspaceId,
    );
    expect(facts).toEqual([
      {
        source_workflow_id: selection.workflowId,
        source_version_id: selection.versionId,
        version_id: item.publishedVersionId,
      },
    ]);
    const newReview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    await queryAsOwner(
      'update app.workspaces set require_publish_approval=true where id=$1',
      [otherWorkspaceId],
      otherWorkspaceId,
    );
    try {
      await expect(
        promotions().apply({
          ...scope(),
          selections: [selection],
          mode: 'publish',
          fingerprint: newReview.fingerprint,
          acknowledgeTargetChanges: [],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'stale' });
      expect(
        (
          await promotions().preview({
            ...scope(),
            selections: [selection],
            mode: 'publish',
          })
        ).compatible,
      ).toBe(false);
      const review = await promotions().preview({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
      });
      const request = await promotions().apply({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
        fingerprint: review.fingerprint,
        acknowledgeTargetChanges: [],
        note: 'Review the promoted draft.',
        idempotencyKey: randomUUID(),
      });
      expect(request.items[0]?.publicationRequestId).not.toBeNull();
    } finally {
      await queryAsOwner(
        'update app.workspaces set require_publish_approval=false where id=$1',
        [otherWorkspaceId],
        otherWorkspaceId,
      );
    }
  });
}

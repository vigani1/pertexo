import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  authoring,
  identity,
  emptyGraph,
  currentRepresentationTag,
  queryAsOwner,
  purgeTestWorkspace,
} from '../../support/workflow-authoring.js';

import { admin, settings, reviews } from './fixture.js';

export function registerBoundsWorkspace100PendingReviews(): void {
  it('bounds a workspace to 100 pending reviews and frees room after a decision', async () => {
    const workspace = await identity.createWorkspaceWithOwner({
      name: 'Review quota',
      slug: `review-quota-${randomUUID().slice(0, 8)}`,
      ownerUserId: actorId,
    });
    const scope = { workspaceId: workspace.id, actorId };
    const policy = await settings.settings(scope);
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
      [workspace.id, admin],
      workspace.id,
    );
    await settings.configure({
      ...scope,
      expectedRevision: policy.revision,
      requirePublishApproval: true,
      idempotencyKey: randomUUID(),
    });
    let first: string | undefined;
    for (let index = 0; index <= 100; index++) {
      const created = await authoring.createWorkflow({
        ...scope,
        name: `Quota ${String(index)}`,
        emptyGraph,
        idempotencyKey: randomUUID(),
      });
      const command = {
        ...scope,
        workflowId: created.workflowId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspace.id,
          { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
        ),
        note: 'Review this change.',
        idempotencyKey: randomUUID(),
      };
      if (index < 100) {
        const pending = await reviews().request(command);
        first ??= pending.id;
      } else {
        await expect(reviews().request(command)).rejects.toMatchObject({
          reason: 'limit',
        });
        if (first === undefined) throw new Error('Expected a pending review');
        await reviews().decide({
          workspaceId: workspace.id,
          actorId: admin,
          reviewId: first,
          decision: 'reject',
          idempotencyKey: randomUUID(),
        });
        expect((await reviews().request(command)).status).toBe('pending');
      }
    }
    const purged = await purgeTestWorkspace(workspace.id);
    expect(purged).toContain('workflow_publication_requests');
  }, 20000);
}

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  otherWorkflowId,
  queryAsOwner,
  purgeTestWorkspace,
} from '../../../support/workflow-authoring.js';
import { store, scope } from './fixture.js';

export function registerPurgesDiscussionRowsExplicitlyLeaves(): void {
  it('purges discussion rows explicitly and leaves the other workspace independent', async () => {
    await store().heartbeat({
      ...scope(),
      tabId: randomUUID(),
      sequence: 1,
      editing: true,
      dirty: true,
      baseRevision: 1,
    });
    const steps = await purgeTestWorkspace(workspaceId, { pageSize: 1 });
    expect(steps).toContain('workflow_comments');
    expect(steps).toContain('workflow_presence_leases');
    expect(
      (
        await store().list({
          workspaceId: otherWorkspaceId,
          workflowId: otherWorkflowId,
          actorId: otherActorId,
          limit: 20,
          status: 'all',
          scope: 'all',
        })
      ).items,
    ).toHaveLength(1);
    expect(
      await queryAsOwner(
        'select count(*)::integer count from app.workflow_comment_threads where workspace_id=$1',
        [workspaceId],
        workspaceId,
      ),
    ).toEqual([{ count: 0 }]);
    // Page-size-one cleanup deliberately spans many short transactions.
  }, 30_000);
}

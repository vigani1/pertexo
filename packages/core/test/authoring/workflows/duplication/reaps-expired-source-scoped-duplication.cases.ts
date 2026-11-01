import { expect, it } from 'vitest';
import {
  WorkflowNotFoundError,
  actorId,
  enforceTestRetention,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  identity,
  queryAsOwner,
  randomUUID,
  purgeTestWorkspace,
} from '../../../support/workflow-authoring.js';

export function registerReapsExpiredSourceScopedDuplication(): void {
  it('reaps expired source-scoped duplication receipts, then erases them through bounded workspace purge', async () => {
    const workspace = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Duplication hold/purge',
      slug: `duplicate-purge-${randomUUID()}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const scopedWorkspace = workspace.id;
    const original = await authoring.createWorkflow({
      actorId,
      workspaceId: scopedWorkspace,
      name: 'Purge source',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const input = {
      actorId,
      workspaceId: scopedWorkspace,
      workflowId: original.workflowId,
      name: 'Purge copy',
      source: { kind: 'draft' as const },
      representationTag: await currentRepresentationTag(
        authoring,
        scopedWorkspace,
        { scopedWorkflowId: original.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: randomUUID(),
    };
    const copied = await authoring.duplicateWorkflow(input);
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.duplicate'",
      [scopedWorkspace],
      scopedWorkspace,
    );
    await enforceTestRetention();
    expect(
      await queryAsOwner(
        "select id from app.idempotency_records where workspace_id=$1 and operation='workflow.duplicate'",
        [scopedWorkspace],
        scopedWorkspace,
      ),
    ).toEqual([]);
    const fresh = await authoring.duplicateWorkflow(input);
    expect(fresh.workflowId).not.toBe(copied.workflowId);
    await purgeTestWorkspace(scopedWorkspace);
    expect(
      await queryAsOwner(
        `select
      (select count(*)::int from app.idempotency_records where workspace_id=$1) receipts,
      (select count(*)::int from app.workflows where workspace_id=$1) workflows,
      (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts`,
        [scopedWorkspace],
        scopedWorkspace,
      ),
    ).toEqual([{ receipts: 0, workflows: 0, drafts: 0 }]);
    await expect(authoring.duplicateWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
}

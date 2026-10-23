import { expect, it } from 'vitest';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  actorId,
  apiPool,
  authoring,
  emptyGraph,
  finishTransactionClient,
  queryAsOwner,
  saveCurrentDraft,
  workflowId,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerAllowsExactlyOneRacingCompare(): void {
  it('allows exactly one racing compare-and-swap save', async () => {
    const results = await Promise.allSettled([
      saveCurrentDraft(authoring, {
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1_000 } },
        workflowId,
        workspaceId,
      }),
      saveCurrentDraft(authoring, {
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 2_000 } },
        workflowId,
        workspaceId,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection?.status).toBe('rejected');
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(WorkflowRevisionConflictError);
    }
    await expect(
      authoring.getDraft(workspaceId, workflowId, actorId),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: 'create-first-workflow',
        name: 'First workflow',
        workspaceId,
      }),
    ).resolves.toMatchObject({ workflowId });
  });

  it('denies saves after the workflow is archived', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-archived-save-proof',
      name: 'Archived save proof',
      workspaceId,
    });
    const client = await apiPool.connect();
    let transactionOpen = false;
    let primaryError: unknown;
    try {
      await client.query('begin');
      transactionOpen = true;
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        "update app.workflows set lifecycle_status = 'archived' where id = $1",
        [created.workflowId],
      );
      await client.query('commit');
      transactionOpen = false;
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishTransactionClient(client, {
      label: 'Archived workflow fixture update',
      primaryError,
      transactionOpen,
    });

    await expect(
      saveCurrentDraft(authoring, {
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1_000 } },
        workflowId: created.workflowId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    const facts = await queryAsOwner<{ audits: string; revision: number }>(
      `select draft.revision,
              (select count(*) from app.audit_events audit
               where audit.target_id = draft.workflow_id
                 and audit.action = 'workflow.draft_saved')::text as audits
       from app.workflow_drafts draft where draft.workflow_id = $1`,
      [created.workflowId],
      workspaceId,
    );
    expect(facts[0]).toEqual({ audits: '0', revision: 1 });
  });
}

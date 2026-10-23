import { expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  actorId,
  apiPool,
  authoring,
  emptyGraph,
  finishTransactionClient,
  otherWorkflowId,
  otherWorkspaceId,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerAtomicallyCreatesWorkflowExactlyOne(): void {
  it('atomically creates a workflow with exactly one revision-1 draft', async () => {
    let workflowId = '';
    const createInput = {
      actorId,
      emptyGraph,
      idempotencyKey: 'create-first-workflow',
      name: 'First workflow',
      workspaceId,
    } as const;
    const created = await authoring.createWorkflow(createInput);
    workflowId = created.workflowId;
    expect(created).toMatchObject({
      workflow: { id: workflowId, name: 'First workflow' },
      draft: { workflowId, revision: 1, workspaceId },
    });
    await expect(
      authoring.getDraft(workspaceId, workflowId, actorId),
    ).resolves.toMatchObject({ revision: 1, workspaceId });
    await expect(authoring.createWorkflow(createInput)).resolves.toMatchObject({
      workflowId,
    });
    await expect(
      authoring.createWorkflow({ ...createInput, name: 'Changed request' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const workflows = await authoring.listWorkflows({ workspaceId, actorId });
    expect(workflows.items.some(({ id }) => id === workflowId)).toBe(true);
    await expect(
      authoring.getWorkflow(workspaceId, workflowId, actorId),
    ).resolves.toMatchObject({ id: workflowId, name: 'First workflow' });
    await expect(
      authoring.getWorkflow(workspaceId, randomUUID(), actorId),
    ).resolves.toBeNull();
    const overflowWorkflows = await queryAsOwner<{ id: string }>(
      `insert into app.workflows
         (id, workspace_id, name, lifecycle_status, activation_status, created_by)
       select gen_random_uuid(), $1, 'Exact lookup ' || ordinal,
              'active', 'inactive', $2
       from generate_series(1, 101) ordinal
       returning id`,
      [workspaceId, actorId],
      workspaceId,
    );
    const firstHundred = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 100,
    });
    const firstPageIds = new Set(firstHundred.items.map(({ id }) => id));
    const beyondFirstPage = overflowWorkflows.find(
      ({ id }) => !firstPageIds.has(id),
    );
    expect(beyondFirstPage).toBeDefined();
    if (beyondFirstPage === undefined)
      throw new Error('expected an exact lookup target beyond the first page');
    const exactWorkflow = await authoring.getWorkflow(
      workspaceId,
      beyondFirstPage.id,
      actorId,
    );
    if (exactWorkflow === null)
      throw new Error('expected exact workflow metadata beyond the first page');
    expect(exactWorkflow.id).toBe(beyondFirstPage.id);
    expect(exactWorkflow.name).toMatch(/^Exact lookup /u);

    const concurrentInput = {
      ...createInput,
      idempotencyKey: 'create-concurrent-workflow',
      name: 'Concurrent workflow',
    };
    const concurrent = await Promise.all([
      authoring.createWorkflow(concurrentInput),
      authoring.createWorkflow(concurrentInput),
    ]);
    expect(concurrent[0].workflowId).toBe(concurrent[1].workflowId);
    await queryAsOwner(
      `update app.workflows
       set updated_at = case id
         when $1::uuid then '2099-09-20T10:00:00.000100Z'::timestamptz
         when $2::uuid then '2099-09-20T10:00:00.000900Z'::timestamptz
         else updated_at
       end
       where workspace_id = $3 and id in ($1::uuid, $2::uuid)`,
      [workflowId, concurrent[0].workflowId, workspaceId],
      workspaceId,
    );
    const recentFirstPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 1,
      order: 'updated_desc',
    });
    expect(recentFirstPage.items.map(({ id }) => id)).toEqual([
      concurrent[0].workflowId,
    ]);
    expect(recentFirstPage.nextCursor).toBeDefined();
    const recentCursor = recentFirstPage.nextCursor;
    if (recentCursor === undefined) throw new Error('Missing recent cursor');
    const recentSecondPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 1,
      order: 'updated_desc',
      after: recentCursor,
    });
    expect(recentSecondPage.items.map(({ id }) => id)).toEqual([workflowId]);
    const listed = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 2,
    });
    expect(Array.isArray(listed.items)).toBe(true);
    const firstPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const firstWorkflow = firstPage.items[0];
    expect(firstWorkflow).toBeDefined();
    if (firstWorkflow === undefined) throw new Error('Missing first page row');
    const rename = await apiPool.connect();
    let renameOpen = false;
    let renameError: unknown;
    try {
      await rename.query('begin');
      renameOpen = true;
      await rename.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await rename.query(
        "update app.workflows set name = 'Renamed between pages' where id = $1",
        [firstWorkflow.id],
      );
      await rename.query('commit');
      renameOpen = false;
    } catch (error: unknown) {
      renameError = error;
    }
    await finishTransactionClient(rename, {
      label: 'Between-pages workflow rename',
      primaryError: renameError,
      transactionOpen: renameOpen,
    });
    const secondPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      after: {
        positionAt: firstWorkflow.createdAt.toISOString(),
        id: firstWorkflow.id,
      },
      limit: 10,
    });
    expect(secondPage.items.map((workflow) => workflow.id)).not.toContain(
      firstWorkflow.id,
    );

    await expect(
      authoring.getDraft(otherWorkspaceId, otherWorkflowId, actorId),
    ).rejects.toThrow('Workflow is not visible');

    const api = await apiPool.connect();
    let apiOpen = false;
    let apiError: unknown;
    try {
      const absent = await api.query<{ drafts: string }>(
        `select (
          (select count(*) from app.workflow_drafts) +
          (select count(*) from app.workflow_versions) +
          (select count(*) from app.audit_events) +
          (select count(*) from app.idempotency_records) +
          (select count(*) from app.outbox_events)
        )::text as drafts`,
      );
      expect(absent.rows[0]?.drafts).toBe('0');
      await api.query('begin');
      apiOpen = true;
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const crossWorkspace = await api.query<{ drafts: string }>(
        `select (
          (select count(*) from app.workflow_drafts where workflow_id = $1) +
          (select count(*) from app.workflow_versions where workflow_id = $1) +
          (select count(*) from app.audit_events where target_id = $1) +
          (select count(*) from app.idempotency_records where resource_id = $1) +
          (select count(*) from app.outbox_events where aggregate_id = $1)
        )::text as drafts`,
        [otherWorkflowId],
      );
      expect(crossWorkspace.rows[0]?.drafts).toBe('0');
      await expect(
        api.query('delete from app.workflow_drafts where workflow_id = $1', [
          workflowId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await api.query('rollback');
      apiOpen = false;
    } catch (error: unknown) {
      apiError = error;
    }
    await finishTransactionClient(api, {
      label: 'Workflow draft RLS proof',
      primaryError: apiError,
      transactionOpen: apiOpen,
    });
  });
}

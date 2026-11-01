import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { WorkflowOrganizationBatchRequest } from '../../../../src/authoring/index.js';
import { commandKey } from '../owned.fixture.js';
import { enforceRetention } from '../../../support/retention.js';
import {
  fixture,
  create,
  place,
  admit,
  item,
  move,
  owner,
  folderIds,
} from './fixture.js';

export function registerAppliesItemOnceSameBatch(): void {
  it('applies an item once when the same batch runs twice at the same time', async () => {
    const scope = await fixture.scope(),
      workflow = await scope.workflow(),
      key = commandKey(),
      body = move(workflow);
    expect(
      await Promise.all([admit(scope, key, body), admit(scope, key, body)]),
    ).toEqual([{ admitted: true }, { admitted: true }]);
    const outcomes = await Promise.all([
      item(scope, key, { request: body, workflowId: workflow }),
      item(scope, key, { request: body, workflowId: workflow }),
    ]);
    expect(outcomes.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const competing = commandKey();
    const claims = await Promise.allSettled([
      admit(scope, competing, move(workflow, 2)),
      admit(scope, competing, move(randomUUID())),
    ]);
    expect(
      claims.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      claims.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('checks the actor is still a member before answering a retry', async () => {
    const scope = await fixture.scope(),
      workflow = await scope.workflow(),
      key = commandKey(),
      body = move(workflow);
    await admit(scope, key, body);
    await item(scope, key, { request: body, workflowId: workflow });
    await owner(
      scope,
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [scope.workspace, scope.actor],
    );
    await expect(admit(scope, key, body)).rejects.toMatchObject({
      name: 'WorkflowNotFoundError',
    });
    await expect(
      item(scope, key, { request: body, workflowId: workflow }),
    ).rejects.toMatchObject({
      name: 'WorkflowNotFoundError',
    });
  });

  it('answers a retried move of an archived workflow only to administrators', async () => {
    const scope = await fixture.scope(),
      single = await scope.workflow(),
      batched = await scope.workflow();
    const singleKey = commandKey(),
      batchKey = commandKey(),
      body = move(batched);
    await place(scope, single, {
      folderId: null,
      expectedOrganizationRevision: 1,
      key: singleKey,
      actor: scope.builder,
    });
    await admit(scope, batchKey, body, scope.builder);
    await item(scope, batchKey, {
      request: body,
      workflowId: batched,
      actor: scope.builder,
    });
    for (const workflowId of [single, batched])
      await fixture.authoring.transitionWorkflowLifecycle({
        workspaceId: scope.workspace,
        actorId: scope.actor,
        workflowId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
    await expect(
      place(scope, single, {
        folderId: null,
        expectedOrganizationRevision: 1,
        key: singleKey,
        actor: scope.builder,
      }),
    ).rejects.toMatchObject({ kind: 'lifecycle' });
    await expect(
      item(scope, batchKey, {
        request: body,
        workflowId: batched,
        actor: scope.builder,
      }),
    ).rejects.toMatchObject({ kind: 'lifecycle' });
    expect(
      await place(scope, batched, {
        folderId: null,
        expectedOrganizationRevision: 2,
      }),
    ).toMatchObject({
      organizationRevision: 3,
    });
  });

  it('retags and cleans up a tag in batches without changing placement', async () => {
    const scope = await fixture.scope(),
      workflow = await scope.workflow(),
      target = await create(scope, 'keep placement');
    const tag = (
      await fixture.tags.createTag({
        workspaceId: scope.workspace,
        actorId: scope.actor,
        key: 'batch-tag',
        idempotencyKey: randomUUID(),
      })
    ).tag;
    await place(scope, workflow, { folderId: target.id });
    const key = commandKey();
    const body: WorkflowOrganizationBatchRequest = {
      operation: 'replace_tags',
      tagIds: [tag.id],
      items: [{ workflowId: workflow, expectedOrganizationRevision: 2 }],
    };
    await admit(scope, key, body);
    expect(
      await item(scope, key, { request: body, workflowId: workflow }),
    ).toMatchObject({
      organizationRevision: 3,
    });
    const cleanup: WorkflowOrganizationBatchRequest = {
      operation: 'tag_cleanup',
      tagId: tag.id,
      items: [{ workflowId: workflow, expectedOrganizationRevision: 3 }],
    };
    await expect(admit(scope, key, cleanup)).rejects.toMatchObject({
      name: 'IdempotencyConflictError',
    });
    await expect(
      admit(scope, commandKey(), cleanup, scope.builder),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    const cleanupKey = commandKey();
    await admit(scope, cleanupKey, cleanup);
    expect(
      await item(scope, cleanupKey, { request: cleanup, workflowId: workflow }),
    ).toMatchObject({
      organizationRevision: 4,
    });
    expect(
      (
        await owner(
          scope,
          'select folder_id from app.workflow_organization_state where workflow_id=$1',
          [workflow],
        )
      ).rows,
    ).toEqual([{ folder_id: target.id }]);
  });

  it('frees a batch key for another request once retention removes it', async () => {
    const scope = await fixture.scope(),
      workflow = await scope.workflow(),
      key = commandKey(),
      body = move(workflow);
    await admit(scope, key, body);
    await owner(
      scope,
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 hour' where workspace_id=$1 and operation='organization.batch'",
      [scope.workspace],
    );
    expect(
      (await enforceRetention(fixture.urls.maintenance)).idempotency_records,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await admit(scope, key, {
        operation: 'replace_tags',
        tagIds: [],
        items: body.items,
      }),
    ).toEqual({ admitted: true });
  });

  it('scopes folders to their workspace for members of that workspace', async () => {
    const scope = await fixture.scope(),
      target = await create(scope, 'private scope'),
      other = await fixture.scope();
    expect(await folderIds(scope, scope.viewer)).toEqual([target.id]);
    expect(await folderIds(other, other.actor)).toEqual([]);
    await expect(
      create(scope, 'denied', null, scope.viewer),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    // Without a workspace, a write reaches no folders.
    expect(
      (await fixture.api.query("update app.workflow_folders set name='forged'"))
        .rowCount,
    ).toBe(0);
  });
}

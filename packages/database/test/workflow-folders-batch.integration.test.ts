import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowOrganizationBatchRequest } from '../src/authoring/index.js';
import {
  commandKey,
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';
import { enforceRetention } from './support/retention.js';

type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;
let fixture: OrganizationOwnedFixture;
let stores: ReturnType<OrganizationOwnedFixture['folderStores']>;
let closeFixture: (() => Promise<void>) | undefined;

const command = (scope: Scope, key: string, actor: string) => ({
  workspaceId: scope.workspace,
  actorId: actor,
  idempotencyKey: key,
});
const create = async (
  scope: Scope,
  name: string,
  parentId: string | null = null,
  actor = scope.actor,
) =>
  (
    await stores.folders.createFolder({
      ...command(scope, commandKey(), actor),
      name,
      parentId,
    })
  ).folder;
const rename = (
  scope: Scope,
  folderId: string,
  name: string,
  expectedFolderRevision: number,
  key = commandKey(),
) =>
  stores.folders.renameFolder({
    ...command(scope, key, scope.actor),
    folderId,
    name,
    expectedFolderRevision,
  });
const moveFolder = (
  scope: Scope,
  folderId: string,
  parentId: string | null,
  expectedFolderRevision: number,
) =>
  stores.folders.moveFolder({
    ...command(scope, commandKey(), scope.actor),
    folderId,
    parentId,
    expectedFolderRevision,
  });
const remove = (scope: Scope, folderId: string, expectedFolderRevision = 1) =>
  stores.folders.deleteFolder({
    ...command(scope, commandKey(), scope.actor),
    folderId,
    expectedFolderRevision,
  });
const place = (
  scope: Scope,
  workflowId: string,
  folderId: string | null,
  expectedOrganizationRevision = 1,
  key = commandKey(),
  actor = scope.actor,
) =>
  stores.folders.placeWorkflow({
    ...command(scope, key, actor),
    workflowId,
    folderId,
    expectedOrganizationRevision,
  });
const admit = (
  scope: Scope,
  key: string,
  request: WorkflowOrganizationBatchRequest,
  actor = scope.actor,
) => stores.batches.admitBatch({ ...command(scope, key, actor), request });
const item = (
  scope: Scope,
  key: string,
  request: WorkflowOrganizationBatchRequest,
  workflowId: string,
  actor = scope.actor,
) =>
  stores.batches.executeBatchItem({
    ...command(scope, key, actor),
    request,
    workflowId,
  });
const move = (
  workflowId: string,
  revision = 1,
): WorkflowOrganizationBatchRequest => ({
  operation: 'move',
  folderId: null,
  items: [{ workflowId, expectedOrganizationRevision: revision }],
});
async function owner(scope: Scope, query: string, values: unknown[] = []) {
  return fixture.transaction(
    fixture.owner,
    scope.workspace,
    scope.actor,
    (client) => client.query(query, values),
  );
}
async function folderIds(scope: Scope, actor: string) {
  return fixture.transaction(
    fixture.api,
    scope.workspace,
    actor,
    async (client) =>
      (
        await client.query<{ id: string }>(
          'select id from app.workflow_folders order by id',
        )
      ).rows.map((row) => row.id),
  );
}

describe.skipIf(!organizationFixtureEnabled)(
  'owned folders and organization batches',
  () => {
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      closeFixture = fixture.close;
      stores = fixture.folderStores();
    }, 60_000);
    afterAll(async () => {
      await closeFixture?.();
    });

    it('keeps sibling names unique regardless of ASCII case, checks revisions and replays', async () => {
      const scope = await fixture.scope();
      const first = await create(scope, ' Ops ');
      expect(first).toMatchObject({
        name: 'Ops',
        parentId: null,
        depth: 1,
        revision: 1,
      });
      await expect(create(scope, 'ops')).rejects.toMatchObject({
        kind: 'name',
      });
      const upper = await create(scope, 'Équipe');
      const lower = await create(scope, 'équipe');
      expect(upper.id).not.toBe(lower.id);
      await expect(create(scope, 'bad\tname')).rejects.toMatchObject({
        name: 'ZodError',
      });
      await expect(create(scope, 'é'.repeat(65))).rejects.toMatchObject({
        name: 'ZodError',
      });
      const other = await fixture.scope();
      await expect(create(other, 'foreign', first.id)).rejects.toMatchObject({
        name: 'WorkflowNotFoundError',
      });
      const key = commandKey();
      const renamed = await rename(scope, first.id, 'Ops', 1, key);
      expect(renamed.folder.revision).toBe(2);
      expect(await rename(scope, first.id, 'Ops', 1, key)).toMatchObject({
        folder: { revision: 2 },
        replayed: true,
      });
      await expect(rename(scope, first.id, 'New', 1)).rejects.toMatchObject({
        kind: 'revision',
      });
    });

    it('keeps folders at most four deep and refuses cycles without touching descendants', async () => {
      const scope = await fixture.scope();
      const a = await create(scope, 'a'),
        b = await create(scope, 'b', a.id),
        c = await create(scope, 'c', b.id),
        d = await create(scope, 'd', c.id);
      await expect(create(scope, 'too deep', d.id)).rejects.toMatchObject({
        kind: 'hierarchy',
      });
      await expect(moveFolder(scope, a.id, d.id, 1)).rejects.toMatchObject({
        kind: 'hierarchy',
      });
      const other = await create(scope, 'other'),
        child = await create(scope, 'child', other.id);
      await expect(moveFolder(scope, b.id, child.id, 1)).rejects.toMatchObject({
        kind: 'hierarchy',
      });
      expect((await moveFolder(scope, b.id, other.id, 1)).folder).toMatchObject(
        { id: b.id, revision: 2, depth: 2 },
      );
      expect(
        (
          await owner(
            scope,
            'select id,revision::int revision from app.workflow_folders where id=$1',
            [d.id],
          )
        ).rows,
      ).toEqual([{ id: d.id, revision: 1 }]);
    });

    it('limits a workspace to 256 folders and lets one of two concurrent siblings win', async () => {
      const scope = await fixture.scope();
      const results = await Promise.allSettled([
        create(scope, 'Shared'),
        create(scope, 'shared'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(
        rejected?.status === 'rejected' ? rejected.reason : undefined,
      ).toMatchObject({ kind: 'name' });
      await owner(
        scope,
        `insert into app.workflow_folders(workspace_id,id,name,name_key)
        select $1,uuidv7(),'f-'||n,'f-'||n from generate_series(1,255) n`,
        [scope.workspace],
      );
      await expect(create(scope, 'overflow')).rejects.toMatchObject({
        kind: 'limit',
      });
      expect(
        (
          await owner(
            scope,
            'select count(*)::int count from app.workflow_folders where workspace_id=$1',
            [scope.workspace],
          )
        ).rows,
      ).toEqual([{ count: 256 }]);
    });

    it('places workflows by organization revision and refuses to delete a folder in use', async () => {
      const scope = await fixture.scope(),
        target = await create(scope, 'target'),
        workflow = await scope.workflow();
      const before = (
        await owner(scope, 'select updated_at from app.workflows where id=$1', [
          workflow,
        ])
      ).rows;
      const key = commandKey();
      expect(await place(scope, workflow, target.id, 1, key)).toMatchObject({
        folderId: target.id,
        organizationRevision: 2,
        replayed: false,
      });
      expect(await place(scope, workflow, target.id, 1, key)).toMatchObject({
        organizationRevision: 2,
        replayed: true,
      });
      await expect(place(scope, workflow, null, 1)).rejects.toMatchObject({
        kind: 'organization_revision',
      });
      await expect(remove(scope, target.id)).rejects.toMatchObject({
        kind: 'not_empty',
      });
      await owner(
        scope,
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [workflow],
      );
      await expect(
        place(scope, workflow, null, 2, commandKey(), scope.builder),
      ).rejects.toMatchObject({ kind: 'lifecycle' });
      await expect(remove(scope, target.id)).rejects.toMatchObject({
        kind: 'not_empty',
      });
      expect(await place(scope, workflow, null, 2)).toMatchObject({
        folderId: null,
        organizationRevision: 3,
      });
      await remove(scope, target.id);
      // Organization changes leave the workflow's own timestamp alone.
      expect(
        (
          await owner(
            scope,
            'select updated_at from app.workflows where id=$1',
            [workflow],
          )
        ).rows,
      ).toEqual(before);
    });

    it('claims a batch key for its whole request before any item changes', async () => {
      const scope = await fixture.scope(),
        a = await scope.workflow(),
        b = await scope.workflow();
      const key = commandKey();
      const body: WorkflowOrganizationBatchRequest = {
        operation: 'move',
        folderId: null,
        items: [
          { workflowId: a, expectedOrganizationRevision: 1 },
          { workflowId: b, expectedOrganizationRevision: 1 },
        ],
      };
      expect(await admit(scope, key, body)).toEqual({ admitted: true });
      const changes: WorkflowOrganizationBatchRequest[] = [
        { operation: 'replace_tags', tagIds: [], items: body.items },
        move(randomUUID()),
        { ...body, items: [...body.items].reverse() },
        {
          ...body,
          items: [
            { workflowId: a, expectedOrganizationRevision: 2 },
            { workflowId: b, expectedOrganizationRevision: 1 },
          ],
        },
      ];
      for (const changed of changes)
        await expect(admit(scope, key, changed)).rejects.toMatchObject({
          name: 'IdempotencyConflictError',
        });
      expect(
        (
          await owner(
            scope,
            'select count(*)::int count from app.workflow_organization_state where workspace_id=$1',
            [scope.workspace],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });

    it('applies an item once when the same batch runs twice at the same time', async () => {
      const scope = await fixture.scope(),
        workflow = await scope.workflow(),
        key = commandKey(),
        body = move(workflow);
      expect(
        await Promise.all([admit(scope, key, body), admit(scope, key, body)]),
      ).toEqual([{ admitted: true }, { admitted: true }]);
      const outcomes = await Promise.all([
        item(scope, key, body, workflow),
        item(scope, key, body, workflow),
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
      await item(scope, key, body, workflow);
      await owner(
        scope,
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [scope.workspace, scope.actor],
      );
      await expect(admit(scope, key, body)).rejects.toMatchObject({
        name: 'WorkflowNotFoundError',
      });
      await expect(item(scope, key, body, workflow)).rejects.toMatchObject({
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
      await place(scope, single, null, 1, singleKey, scope.builder);
      await admit(scope, batchKey, body, scope.builder);
      await item(scope, batchKey, body, batched, scope.builder);
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
        place(scope, single, null, 1, singleKey, scope.builder),
      ).rejects.toMatchObject({ kind: 'lifecycle' });
      await expect(
        item(scope, batchKey, body, batched, scope.builder),
      ).rejects.toMatchObject({ kind: 'lifecycle' });
      expect(await place(scope, batched, null, 2)).toMatchObject({
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
      await place(scope, workflow, target.id);
      const key = commandKey();
      const body: WorkflowOrganizationBatchRequest = {
        operation: 'replace_tags',
        tagIds: [tag.id],
        items: [{ workflowId: workflow, expectedOrganizationRevision: 2 }],
      };
      await admit(scope, key, body);
      expect(await item(scope, key, body, workflow)).toMatchObject({
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
      expect(await item(scope, cleanupKey, cleanup, workflow)).toMatchObject({
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
        (
          await fixture.api.query(
            "update app.workflow_folders set name='forged'",
          )
        ).rowCount,
      ).toBe(0);
    });
  },
);

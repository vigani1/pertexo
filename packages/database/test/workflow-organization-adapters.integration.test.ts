import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  WorkflowFolderConflictError,
  type WorkflowOrganizationBatchRequest,
} from '../src/api.js';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';

describe.skipIf(!organizationFixtureEnabled)(
  'owned public folder and batch database adapters',
  () => {
    let fixture: OrganizationOwnedFixture;
    let closeFixture: (() => Promise<void>) | undefined;
    let stores: ReturnType<OrganizationOwnedFixture['folderStores']>;
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      closeFixture = fixture.close;
      stores = fixture.folderStores();
    }, 60_000);
    afterAll(async () => {
      await closeFixture?.();
    });

    it('executes strict folder CRUD, member reads and shared placement CAS', async () => {
      const scope = await fixture.scope();
      const context = { workspaceId: scope.workspace, actorId: scope.actor };
      const created = await stores.folders.createFolder({
        ...context,
        name: ' Ops ',
        parentId: null,
        idempotencyKey: randomUUID(),
      });
      expect(created.folder).toMatchObject({
        name: 'Ops',
        revision: 1,
        depth: 1,
      });
      const folderId = created.folder.id;
      expect(
        await stores.folders.listFolders({ ...context, actorId: scope.viewer }),
      ).toEqual({ items: [created.folder] });
      await expect(
        stores.folders.createFolder({
          ...context,
          name: 'ops',
          parentId: null,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowFolderConflictError);
      const renamed = await stores.folders.renameFolder({
        ...context,
        folderId,
        name: 'Renamed',
        expectedFolderRevision: 1,
        idempotencyKey: randomUUID(),
      });
      expect(renamed.folder.revision).toBe(2);
      const moved = await stores.folders.moveFolder({
        ...context,
        folderId,
        parentId: null,
        expectedFolderRevision: 2,
        idempotencyKey: randomUUID(),
      });
      expect(moved.folder.revision).toBe(3);
      const workflowId = await scope.workflow();
      const placement = {
        ...context,
        workflowId,
        folderId,
        expectedOrganizationRevision: 1,
        idempotencyKey: randomUUID(),
      };
      expect(await stores.folders.placeWorkflow(placement)).toEqual({
        workflowId,
        folderId,
        organizationRevision: 2,
        replayed: false,
      });
      expect(await stores.folders.placeWorkflow(placement)).toMatchObject({
        replayed: true,
      });
      await expect(
        stores.folders.deleteFolder({
          ...context,
          folderId,
          expectedFolderRevision: 3,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ kind: 'not_empty' });
      await stores.folders.placeWorkflow({
        ...placement,
        folderId: null,
        expectedOrganizationRevision: 2,
        idempotencyKey: randomUUID(),
      });
      expect(
        await stores.folders.deleteFolder({
          ...context,
          folderId,
          expectedFolderRevision: 3,
          idempotencyKey: randomUUID(),
        }),
      ).toEqual({ folderId, deleted: true, replayed: false });
    });

    it('claims the batch key for the whole request and replays each item', async () => {
      const scope = await fixture.scope();
      const context = { workspaceId: scope.workspace, actorId: scope.actor };
      const workflowId = await scope.workflow();
      const request: WorkflowOrganizationBatchRequest = {
        operation: 'move',
        folderId: null,
        items: [{ workflowId, expectedOrganizationRevision: 1 }],
      };
      const input = { ...context, request, idempotencyKey: randomUUID() };
      expect(await stores.batches.admitBatch(input)).toEqual({
        admitted: true,
      });
      await expect(
        stores.batches.admitBatch({
          ...input,
          request: {
            operation: 'replace_tags',
            tagIds: [],
            items: request.items,
          },
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(
        await stores.batches.executeBatchItem({ ...input, workflowId }),
      ).toEqual({
        workflowId,
        folderId: null,
        organizationRevision: 2,
        replayed: false,
      });
      expect(
        await stores.batches.executeBatchItem({ ...input, workflowId }),
      ).toMatchObject({
        organizationRevision: 2,
        replayed: true,
      });
    });

    it('retags and cleans up through batches without losing placement', async () => {
      const scope = await fixture.scope();
      const context = { workspaceId: scope.workspace, actorId: scope.actor };
      const workflowId = await scope.workflow();
      const tag = await fixture.tags.createTag({
        ...context,
        key: 'owned-tag',
        idempotencyKey: randomUUID(),
      });
      const destination = await stores.folders.createFolder({
        ...context,
        name: 'Placement',
        parentId: null,
        idempotencyKey: randomUUID(),
      });
      await stores.folders.placeWorkflow({
        ...context,
        workflowId,
        folderId: destination.folder.id,
        expectedOrganizationRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const replacement = {
        ...context,
        idempotencyKey: randomUUID(),
        request: {
          operation: 'replace_tags' as const,
          tagIds: [tag.tag.id],
          items: [{ workflowId, expectedOrganizationRevision: 2 }],
        },
      };
      await stores.batches.admitBatch(replacement);
      expect(
        await stores.batches.executeBatchItem({ ...replacement, workflowId }),
      ).toEqual({ workflowId, organizationRevision: 3, replayed: false });
      const cleanup = {
        ...context,
        idempotencyKey: randomUUID(),
        request: {
          operation: 'tag_cleanup' as const,
          tagId: tag.tag.id,
          items: [{ workflowId, expectedOrganizationRevision: 3 }],
        },
      };
      await stores.batches.admitBatch(cleanup);
      expect(
        await stores.batches.executeBatchItem({ ...cleanup, workflowId }),
      ).toEqual({ workflowId, organizationRevision: 4, replayed: false });
      const placement = await fixture.transaction(
        fixture.api,
        scope.workspace,
        scope.actor,
        (client) =>
          client.query<{ folder_id: string }>(
            'select folder_id from app.workflow_organization_state where workspace_id=$1 and workflow_id=$2',
            [scope.workspace, workflowId],
          ),
      );
      expect(placement.rows).toEqual([{ folder_id: destination.folder.id }]);
    });
  },
);

import { IdempotencyConflictError } from '@pertexo/database/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './owned.fixture.js';

describe.skipIf(!organizationFixtureEnabled)(
  'a damaged organization receipt is reported as stored-data corruption',
  () => {
    let fixture: OrganizationOwnedFixture;
    let stores: ReturnType<OrganizationOwnedFixture['folderStores']>;
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      stores = fixture.folderStores();
    }, 120_000);
    afterAll(() => fixture.close(), 30_000);

    async function damage(workspace: string, actor: string, operation: string) {
      const { rowCount } = await fixture.transaction(
        fixture.owner,
        workspace,
        actor,
        (client) =>
          client.query(
            `update app.idempotency_records set result_ref='{"damaged":true}'::jsonb
             where workspace_id=$1 and operation=$2`,
            [workspace, operation],
          ),
      );
      expect(rowCount).toBe(1);
    }

    it('rejects an admitted batch whose receipt lost its admission flag', async () => {
      const { actor, workspace, workflow } = await fixture.scope();
      const input = {
        workspaceId: workspace,
        actorId: actor,
        idempotencyKey: randomUUID(),
        request: {
          operation: 'move' as const,
          folderId: null,
          items: [
            { workflowId: await workflow(), expectedOrganizationRevision: 1 },
          ],
        },
      };
      await stores.batches.admitBatch(input);
      await damage(workspace, actor, 'organization.batch');
      await expect(stores.batches.admitBatch(input)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it('rejects a sharing receipt missing the folder identity instead of replaying partial success', async () => {
      const { actor, workspace } = await fixture.scope();
      const scope = { workspaceId: workspace, actorId: actor };
      const { folder } = await stores.folders.createFolder({
        ...scope,
        name: 'Sharing receipt',
        parentId: null,
        idempotencyKey: randomUUID(),
      });
      const input = {
        ...scope,
        folderId: folder.id,
        idempotencyKey: randomUUID(),
        request: {
          mode: 'workspace' as const,
          expectedFolderRevision: folder.revision,
          grants: [],
        },
      };
      await stores.folders.replaceSharing(input);
      await fixture.transaction(fixture.owner, workspace, actor, (client) =>
        client.query(
          `update app.idempotency_records set result_ref=result_ref-'folderId' where workspace_id=$1 and operation='folder.sharing'`,
          [workspace],
        ),
      );
      await expect(stores.folders.replaceSharing(input)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it('creating a folder and a tag, and placing a workflow', async () => {
      const { actor, workspace, workflow } = await fixture.scope();
      const scope = { workspaceId: workspace, actorId: actor };
      const folderKey = randomUUID();
      const folder = {
        ...scope,
        name: 'Receipts',
        parentId: null,
        idempotencyKey: folderKey,
      };
      const created = await stores.folders.createFolder(folder);
      await damage(workspace, actor, 'folder.create');
      await expect(stores.folders.createFolder(folder)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );

      const tagKey = randomUUID();
      const tag = { ...scope, key: 'receipts', idempotencyKey: tagKey };
      await fixture.tags.createTag(tag);
      await damage(workspace, actor, 'tag.create');
      await expect(fixture.tags.createTag(tag)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );

      const placeKey = randomUUID();
      const place = {
        ...scope,
        workflowId: await workflow(),
        folderId: created.folder.id,
        expectedOrganizationRevision: 1,
        idempotencyKey: placeKey,
      };
      await stores.folders.placeWorkflow(place);
      await damage(workspace, actor, 'folder.place');
      await expect(stores.folders.placeWorkflow(place)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    }, 60_000);
  },
);

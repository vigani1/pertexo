import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './owned.fixture.js';

describe.skipIf(!organizationFixtureEnabled)(
  'a damaged organization receipt is refused as a conflict, not a crash',
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

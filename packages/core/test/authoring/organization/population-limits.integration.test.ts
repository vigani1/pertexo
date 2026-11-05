import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './owned.fixture.js';

describe.skipIf(!organizationFixtureEnabled)(
  'folder operations at their supported populations',
  () => {
    let fixture: OrganizationOwnedFixture;
    let stores: ReturnType<OrganizationOwnedFixture['folderStores']>;
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      stores = fixture.folderStores();
    }, 120_000);
    afterAll(() => fixture.close());

    it('reviews and performs workflow and folder moves with 256 maximum-length folder names', async () => {
      const { workspace, actor, workflow } = await fixture.scope();
      const scope = { workspaceId: workspace, actorId: actor };
      const ids = await fixture.transaction(
        fixture.owner,
        workspace,
        actor,
        async (client) =>
          (
            await client.query<{ id: string }>(
              `insert into app.workflow_folders(id,workspace_id,name,name_key,parent_id) select uuidv7(),$1,lpad(n::text,4,'0')||repeat('x',124),lpad(n::text,4,'0')||repeat('x',124),null from generate_series(1,256) n returning id`,
              [workspace],
            )
          ).rows.map((row) => row.id),
      );
      const [folderId, parentId] = ids;
      if (folderId === undefined || parentId === undefined)
        throw new Error('Expected folder fixtures');
      const workflowId = await workflow();
      const review = await stores.folders.reviewMove({
        ...scope,
        request: {
          kind: 'workflows',
          workflowIds: [workflowId],
          destinationFolderId: folderId,
        },
      });
      expect(review.items).toHaveLength(1);
      await stores.folders.placeWorkflow({
        ...scope,
        workflowId,
        folderId,
        expectedOrganizationRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await stores.folders.moveFolder({
        ...scope,
        folderId,
        parentId,
        expectedFolderRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await fixture.transaction(
        fixture.owner,
        workspace,
        actor,
        async (client) => {
          expect(
            (
              await client.query(
                'select folder_id from app.workflow_organization_state where workflow_id=$1',
                [workflowId],
              )
            ).rows,
          ).toEqual([{ folder_id: folderId }]);
          expect(
            (
              await client.query(
                'select parent_id from app.workflow_folders where id=$1',
                [folderId],
              )
            ).rows,
          ).toEqual([{ parent_id: parentId }]);
          expect(
            (
              await client.query(
                'select count(*)::int count from app.workflow_folders where workspace_id=$1',
                [workspace],
              )
            ).rows,
          ).toEqual([{ count: 256 }]);
        },
      );
    });

    it.each([
      { kind: 'UTF-8', label: '界'.repeat(256) },
      { kind: 'JSON-escaped', label: '\u0001'.repeat(256) },
    ])(
      'sets and exactly replays sharing with 100 member grants and full-size $kind labels',
      async ({ label }) => {
        const { workspace, actor } = await fixture.scope();
        const scope = { workspaceId: workspace, actorId: actor };
        const { folder } = await stores.folders.createFolder({
          ...scope,
          name: 'Shared at capacity',
          parentId: null,
          idempotencyKey: randomUUID(),
        });
        const users = Array.from({ length: 100 }, () => randomUUID());
        for (const id of users)
          await fixture.identity.createUser({
            id,
            email: `${id}@population.test`,
            displayName: label,
          });
        await fixture.transaction(fixture.owner, workspace, actor, (client) =>
          client.query(
            `insert into app.workspace_memberships(workspace_id,user_id,role,status) select $1,id,'viewer','active' from unnest($2::uuid[]) id`,
            [workspace, users],
          ),
        );
        const input = {
          ...scope,
          folderId: folder.id,
          idempotencyKey: randomUUID(),
          request: {
            mode: 'restricted' as const,
            expectedFolderRevision: folder.revision,
            grants: users.map((userId) => ({
              kind: 'member' as const,
              userId,
              access: 'viewer' as const,
            })),
          },
        };
        const saved = await stores.folders.replaceSharing(input);
        expect(saved.grants).toHaveLength(100);
        expect(Object.values(saved.labels ?? {})).toEqual(
          Array.from({ length: 100 }, () => label),
        );
        expect(await stores.folders.replaceSharing(input)).toEqual({
          ...saved,
          replayed: true,
        });
        const read = await stores.folders.readSharing({
          ...scope,
          folderId: folder.id,
        });
        expect(read.grants).toHaveLength(100);
        expect(read.mode).toBe('restricted');
      },
    );

    it('continues refusing real outbox payloads above 4 KB', () => {
      expect(() =>
        canonicalOutboxPayloadChecksum({ value: 'x'.repeat(4_097) }),
      ).toThrow('outbox payload');
    });
  },
);

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './owned.fixture.js';

// Before batch D, both public review tokens and audit grant digests used this
// 4 KiB outbox algorithm. Do not use the replacement audience digest here.
const oldDigest = canonicalOutboxPayloadChecksum;

describe.skipIf(!organizationFixtureEnabled)(
  'reviews issued before batch D',
  () => {
    let fixture: OrganizationOwnedFixture;
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
    }, 120_000);
    afterAll(() => fixture.close());

    it.each(['workflows', 'folder'] as const)(
      'accepts an old %s audience token and commits the reviewed move',
      async (kind) => {
        const { workspace, actor, workflow } = await fixture.scope();
        const scope = { workspaceId: workspace, actorId: actor };
        const { folders } = fixture.folderStores();
        const { folder: restricted } = await folders.createFolder({
          ...scope,
          name: 'Private',
          parentId: null,
          idempotencyKey: randomUUID(),
        });
        const sharing = await folders.replaceSharing({
          ...scope,
          folderId: restricted.id,
          idempotencyKey: randomUUID(),
          request: {
            mode: 'restricted',
            grants: [],
            expectedFolderRevision: restricted.revision,
          },
        });
        const id =
          kind === 'workflows'
            ? await workflow()
            : (
                await folders.createFolder({
                  ...scope,
                  name: 'Child',
                  parentId: restricted.id,
                  idempotencyKey: randomUUID(),
                })
              ).folder.id;
        if (kind === 'workflows')
          await folders.placeWorkflow({
            ...scope,
            workflowId: id,
            folderId: restricted.id,
            expectedOrganizationRevision: 1,
            idempotencyKey: randomUUID(),
          });
        const oldFolders = await fixture.transaction(
          fixture.owner,
          workspace,
          actor,
          async (client) =>
            (
              await client.query<{
                id: string;
                name: string;
                parent_id: string | null;
                revision: string;
                access_mode: string;
              }>(
                'select id,name,parent_id,revision::text,access_mode from app.workflow_folders where workspace_id=$1 order by id',
                [workspace],
              )
            ).rows,
        );
        const token = oldDigest({
          workspaceId: workspace,
          kind,
          source: {
            id,
            folder_id: restricted.id,
            revision: kind === 'workflows' ? 2 : '1',
          },
          destinationFolderId: null,
          folders: oldFolders,
        });
        const audienceReview = { acknowledge: true as const, token };
        if (kind === 'workflows') {
          await expect(
            folders.placeWorkflow({
              ...scope,
              workflowId: id,
              folderId: null,
              expectedOrganizationRevision: 2,
              audienceReview,
              idempotencyKey: randomUUID(),
            }),
          ).resolves.toMatchObject({ organizationRevision: 3, folderId: null });
        } else {
          await expect(
            folders.moveFolder({
              ...scope,
              folderId: id,
              parentId: null,
              expectedFolderRevision: 1,
              audienceReview,
              idempotencyKey: randomUUID(),
            }),
          ).resolves.toMatchObject({ folder: { parentId: null, revision: 2 } });
        }
        await fixture.transaction(
          fixture.owner,
          workspace,
          actor,
          async (client) => {
            const row =
              kind === 'workflows'
                ? await client.query(
                    'select folder_id from app.workflow_organization_state where workflow_id=$1',
                    [id],
                  )
                : await client.query(
                    'select parent_id from app.workflow_folders where id=$1',
                    [id],
                  );
            expect(row.rows).toEqual([
              kind === 'workflows' ? { folder_id: null } : { parent_id: null },
            ]);
            const audit = await client.query(
              "select metadata from app.audit_events where workspace_id=$1 and target_id=$2 and action='workflow.folder_sharing_changed'",
              [workspace, restricted.id],
            );
            expect(audit.rows).toEqual([
              {
                metadata: {
                  mode: 'restricted',
                  principals: 0,
                  previousGrants: oldDigest([]),
                  grants: oldDigest([]),
                  revision: sharing.revision,
                },
              },
            ]);
          },
        );
      },
    );
  },
);

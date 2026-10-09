import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowNotFoundError } from '../src/authoring/workflow-authoring-errors.js';
import {
  commandKey,
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';

let fixture: OrganizationOwnedFixture;
let stores: ReturnType<OrganizationOwnedFixture['organizationStores']>;
let closeFixture: (() => Promise<void>) | undefined;
type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;
const context = (scope: Scope, actorId = scope.actor) => ({
  workspaceId: scope.workspace,
  actorId,
});
async function favorite(
  scope: Scope,
  workflowId: string,
  actorId = scope.actor,
) {
  return stores.favorites.setFavorite({
    ...context(scope, actorId),
    workflowId,
    favorite: true,
  });
}
async function attach(scope: Scope, workflowId: string, tagId: string) {
  await fixture.tags.replaceTags({
    ...context(scope),
    workflowId,
    tagIds: [tagId],
    expectedOrganizationRevision: 1,
    idempotencyKey: randomUUID(),
  });
}
describe.skipIf(!organizationFixtureEnabled)(
  'owned workflow organization reader',
  () => {
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      closeFixture = fixture.close;
      stores = fixture.organizationStores();
    }, 60_000);
    afterAll(async () => {
      await closeFixture?.();
    });

    it('uses literal case-sensitive search with only U+0020 trimming and UTF-8 bounds', async () => {
      const scope = await fixture.scope();
      const names = [
        'Alpha%_\\é',
        'Alpha ordinary',
        'alpha ordinary',
        'Alpha\tordinary',
        '表'.repeat(42),
      ];
      for (const name of names) await scope.workflow(name);
      for (const query of ['%', '_', '\\', 'é', '  %_\\  ']) {
        const page = await stores.reader.listWorkflows({
          ...context(scope),
          query,
        });
        expect(page.items.map((item) => item.workflow.name)).toEqual([
          names[0],
        ]);
      }
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope),
            query: 'alpha',
          })
        ).items.map((item) => item.workflow.name),
      ).toEqual(['alpha ordinary']);
      expect(
        (
          await stores.reader.listWorkflows({ ...context(scope), query: '\t' })
        ).items.map((item) => item.workflow.name),
      ).toEqual(['Alpha\tordinary']);
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope),
            query: '表'.repeat(42),
          })
        ).items,
      ).toHaveLength(1);
      await expect(
        stores.reader.listWorkflows({
          ...context(scope),
          query: '表'.repeat(43),
        }),
      ).rejects.toThrow();
      expect(
        (await stores.reader.listWorkflows({ ...context(scope), query: '   ' }))
          .items,
      ).toHaveLength(5);
      expect(
        await stores.reader.listWorkflows({ ...context(scope), query: '\0' }),
      ).toEqual({ items: [], nextCursor: null });
    });
    it('projects placement and intersects exact folder/root filters before pagination', async () => {
      const scope = await fixture.scope();
      const { folders } = fixture.folderStores();
      const createFolder = async (
        name: string,
        parentId: string | null = null,
      ) =>
        (
          await folders.createFolder({
            ...context(scope),
            name,
            parentId,
            idempotencyKey: commandKey(),
          })
        ).folder.id;
      const parent = await createFolder('parent'),
        child = await createFolder('child', parent);
      const unfiled = await scope.workflow('match unfiled'),
        inParent = await scope.workflow('match parent'),
        inChild = await scope.workflow('match child');
      for (const [workflow, folder] of [
        [inParent, parent],
        [inChild, child],
      ] as const)
        await folders.placeWorkflow({
          ...context(scope),
          workflowId: workflow,
          folderId: folder,
          expectedOrganizationRevision: 1,
          idempotencyKey: commandKey(),
        });
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope),
            folderId: parent,
            query: 'match',
            limit: 1,
          })
        ).items.map((item) => item.workflow.id),
      ).toEqual([inParent]);
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope),
            folderId: 'root',
          })
        ).items.map((item) => item.workflow.id),
      ).toEqual([unfiled]);
      expect(
        (
          await stores.reader.getWorkflow({
            ...context(scope),
            workflowId: inChild,
          })
        )?.organization.folderId,
      ).toBe(child);
      expect(
        await stores.reader.listWorkflows({
          ...context(scope),
          folderId: randomUUID(),
        }),
      ).toEqual({ items: [], nextCursor: null });
    });

    it('intersects filters before pagination and keeps actor-private favorite state out of other projections', async () => {
      const scope = await fixture.scope();
      const tag = (
        await fixture.tags.createTag({
          ...context(scope),
          key: 'selected',
          idempotencyKey: randomUUID(),
        })
      ).tag;
      await scope.workflow('unmatched first');
      const first = await scope.workflow('match first'),
        second = await scope.workflow('match second');
      await attach(scope, first, tag.id);
      await attach(scope, second, tag.id);
      await favorite(scope, first);
      await favorite(scope, second);
      const page = await stores.reader.listWorkflows({
        ...context(scope),
        query: 'match',
        tagId: tag.id,
        favoritesOnly: true,
        limit: 1,
      });
      expect(page.items.map((item) => item.workflow.id)).toEqual([first]);
      expect(page.nextCursor?.id).toBe(first);
      if (page.nextCursor === null)
        throw new Error('Expected a bounded continuation');
      const last = await stores.reader.listWorkflows({
        ...context(scope),
        query: 'match',
        tagId: tag.id,
        favoritesOnly: true,
        limit: 1,
        after: page.nextCursor,
      });
      expect(last.items.map((item) => item.workflow.id)).toEqual([second]);
      expect(last.nextCursor).toBeNull();
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope, scope.viewer),
            favoritesOnly: true,
          })
        ).items,
      ).toEqual([]);
      const viewer = await stores.reader.getWorkflow({
        ...context(scope, scope.viewer),
        workflowId: first,
      });
      expect(viewer?.organization.isFavorite).toBe(false);
      expect(Object.keys(viewer?.organization ?? {}).sort()).toEqual([
        'folderId',
        'isFavorite',
        'organizationRevision',
        'tags',
      ]);
      expect(viewer?.organization.tags).toEqual([tag]);
      expect(viewer?.organization.organizationRevision).toBe(2);
    });

    it('keeps unknown and foreign tag filters scoped empty and foreign workflows undisclosed', async () => {
      const scope = await fixture.scope(),
        foreign = await fixture.scope();
      await scope.workflow();
      const foreignId = await foreign.workflow();
      const tag = (
        await fixture.tags.createTag({
          ...context(foreign),
          key: 'foreign',
          idempotencyKey: randomUUID(),
        })
      ).tag;
      for (const tagId of [tag.id, randomUUID()])
        expect(
          await stores.reader.listWorkflows({ ...context(scope), tagId }),
        ).toEqual({ items: [], nextCursor: null });
      expect(
        await stores.reader.getWorkflow({
          ...context(scope),
          workflowId: foreignId,
        }),
      ).toBeNull();
    });

    it('preserves legacy all-lifecycle default and workflow timestamps across organization writes', async () => {
      const scope = await fixture.scope();
      const first = await scope.workflow('active'),
        archived = await scope.workflow('archived');
      await fixture.authoring.transitionWorkflowLifecycle({
        ...context(scope),
        workflowId: archived,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const before = await stores.reader.listWorkflows({
        ...context(scope),
        order: 'updated_desc',
      });
      const tag = (
        await fixture.tags.createTag({
          ...context(scope),
          key: 'timestamps',
          idempotencyKey: randomUUID(),
        })
      ).tag;
      await attach(scope, first, tag.id);
      await favorite(scope, archived, scope.viewer);
      const after = await stores.reader.listWorkflows({
        ...context(scope),
        order: 'updated_desc',
        limit: 1,
      });
      expect(after.items[0]?.workflow).toEqual(before.items[0]?.workflow);
      if (after.nextCursor === null)
        throw new Error('Expected updated-time continuation');
      const tail = await stores.reader.listWorkflows({
        ...context(scope),
        order: 'updated_desc',
        limit: 1,
        after: after.nextCursor,
      });
      expect(tail.items[0]?.workflow).toEqual(before.items[1]?.workflow);
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope),
            view: 'active',
          })
        ).items.map((item) => item.workflow.id),
      ).toEqual([first]);
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope, scope.viewer),
            view: 'archived',
            favoritesOnly: true,
          })
        ).items.map((item) => item.workflow.id),
      ).toEqual([archived]);
    });

    it('drops an unfavorited workflow from the favorites view', async () => {
      const scope = await fixture.scope(),
        workflowId = await scope.workflow();
      await favorite(scope, workflowId);
      await stores.favorites.setFavorite({
        ...context(scope),
        workflowId,
        favorite: false,
      });
      expect(
        (await stores.reader.getWorkflow({ ...context(scope), workflowId }))
          ?.organization,
      ).toEqual({
        tags: [],
        folderId: null,
        organizationRevision: 1,
        isFavorite: false,
      });
      expect(
        (
          await stores.reader.listWorkflows({
            ...context(scope),
            favoritesOnly: true,
          })
        ).items,
      ).toEqual([]);
    });

    it('rechecks current authority on continuation instead of treating the page position as authorization', async () => {
      const scope = await fixture.scope();
      await scope.workflow('first');
      await scope.workflow('second');
      const page = await stores.reader.listWorkflows({
        ...context(scope, scope.viewer),
        limit: 1,
      });
      if (page.nextCursor === null) throw new Error('Expected continuation');
      await fixture.transaction(
        fixture.owner,
        scope.workspace,
        scope.actor,
        (client) =>
          client.query(
            "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
            [scope.workspace, scope.viewer],
          ),
      );
      await expect(
        stores.reader.listWorkflows({
          ...context(scope, scope.viewer),
          limit: 1,
          after: page.nextCursor,
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    });
  },
);

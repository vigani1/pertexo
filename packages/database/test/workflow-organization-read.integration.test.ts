import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowFavoriteAbsenceTokenAuthority } from '../src/authoring/workflow-favorites.js';
import { WorkflowNotFoundError } from '../src/authoring/workflow-authoring-errors.js';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';

// This fixture qualifies SQL filtering/projection, not MAC authentication.
// Actual API codec composition has its own owned PostgreSQL integration suite.
const absenceTokens: WorkflowFavoriteAbsenceTokenAuthority = {
  issue: (_scope, proof) =>
    `absent.v1.${String(proof.issuedAtSeconds)}.${String(proof.issuedAtSeconds + 86_400)}.${'A'.repeat(43)}`,
  verify: (token, _scope, generation) => {
    const issuedAtSeconds = Number(token.split('.')[2]);
    return {
      generation,
      issuedAtSeconds,
      expiresAtSeconds: issuedAtSeconds + 86_400,
    };
  },
};
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
  const current = await stores.favorites.readFavorite({
    ...context(scope, actorId),
    workflowId,
  });
  return stores.favorites.setFavorite({
    ...context(scope, actorId),
    workflowId,
    favorite: true,
    expectedFavoriteRevision: current.favoriteRevision,
    idempotencyKey: randomUUID(),
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
      stores = fixture.organizationStores(absenceTokens);
      await fixture.owner.query(
        'update app.workflow_organization_rollout set writes_enabled=true',
      );
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
      expect(viewer?.organization.favoriteRevision).toMatch(/^absent\.v1\./u);
      expect(Object.keys(viewer?.organization ?? {}).sort()).toEqual([
        'favoriteRevision',
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

    it('reads compatible metadata while writers are off, including fresh absence and false tombstones', async () => {
      const scope = await fixture.scope(),
        workflowId = await scope.workflow();
      const saved = await favorite(scope, workflowId);
      const removed = await stores.favorites.setFavorite({
        ...context(scope),
        workflowId,
        favorite: false,
        expectedFavoriteRevision: saved.favoriteRevision,
        idempotencyKey: randomUUID(),
      });
      await fixture.owner.query(
        'update app.workflow_organization_rollout set writes_enabled=false',
      );
      try {
        const row = await stores.reader.getWorkflow({
          ...context(scope),
          workflowId,
        });
        expect(row?.organization).toEqual({
          tags: [],
          folderId: null,
          organizationRevision: 1,
          isFavorite: false,
          favoriteRevision: removed.favoriteRevision,
        });
        const viewer = await stores.reader.getWorkflow({
          ...context(scope, scope.viewer),
          workflowId,
        });
        expect(viewer?.organization.favoriteRevision).toMatch(/^absent\.v1\./u);
        expect(
          (
            await stores.reader.listWorkflows({
              ...context(scope),
              favoritesOnly: true,
            })
          ).items,
        ).toEqual([]);
      } finally {
        await fixture.owner.query(
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
      }
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

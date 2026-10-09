import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowTagConflictError } from '../src/authoring/organization/tags.repository.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from '../src/authoring/workflow-authoring-errors.js';
import { WorkflowOrganizationUnavailableError } from '../src/authoring/organization/favorites.repository.js';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';
let fixture: OrganizationOwnedFixture;
let closeFixture: (() => Promise<void>) | undefined;
type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;
function context(s: Scope, actorId = s.actor) {
  return { workspaceId: s.workspace, actorId };
}
async function owner(s: Scope, sql: string, args: unknown[] = []) {
  return fixture.transaction(fixture.owner, s.workspace, s.actor, (client) =>
    client.query(sql, args),
  );
}
async function tag(s: Scope, key = 'example') {
  return (
    await fixture.tags.createTag({
      ...context(s),
      key,
      idempotencyKey: randomUUID(),
    })
  ).tag;
}
describe.skipIf(!organizationFixtureEnabled)(
  'owned workflow tag database adapter',
  () => {
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      closeFixture = fixture.close;
      await fixture.owner.query(
        'update app.workflow_organization_rollout set writes_enabled=true',
      );
    }, 60_000);
    afterAll(async () => {
      await closeFixture?.();
    });

    it('canonicalizes command identity, paginates vocabulary by UUID and preserves rename identity', async () => {
      const s = await fixture.scope();
      const key = randomUUID();
      const created = await fixture.tags.createTag({
        ...context(s),
        key: '  Ops-2  ',
        idempotencyKey: key,
      });
      expect(created.tag.key).toBe('ops-2');
      expect(
        await fixture.tags.createTag({
          ...context(s),
          key: 'ops-2',
          idempotencyKey: key,
        }),
      ).toEqual({ ...created, replayed: true });
      const others = await Promise.all(
        ['alpha', 'beta'].map((name) => tag(s, name)),
      );
      const ids = [created.tag.id, ...others.map((item) => item.id)].sort();
      const first = await fixture.tags.listTags({
        ...context(s, s.viewer),
        limit: 2,
      });
      expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
      expect(first.nextId).toBe(ids[1]);
      if (first.nextId === null) throw new Error('Expected next page');
      expect(
        await fixture.tags.listTags({
          ...context(s, s.viewer),
          limit: 2,
          afterId: first.nextId,
        }),
      ).toEqual({
        items: [expect.objectContaining({ id: ids[2] })],
        nextId: null,
      });
      const renamed = await fixture.tags.renameTag({
        ...context(s),
        tagId: created.tag.id,
        expectedTagRevision: 1,
        key: 'renamed',
        idempotencyKey: randomUUID(),
      });
      expect(renamed.tag).toEqual({
        id: created.tag.id,
        key: 'renamed',
        revision: 2,
      });
      expect(
        (await fixture.tags.listTags({ ...context(s), limit: 100 })).items.map(
          (item) => item.id,
        ),
      ).toEqual(ids);
      expect(Object.keys(first).sort()).toEqual(['items', 'nextId']);
    });

    it('bounds page inputs and denies builder vocabulary mutations while allowing viewer reads', async () => {
      const s = await fixture.scope();
      for (const limit of [0, 101, 1.5])
        await expect(
          fixture.tags.listTags({ ...context(s), limit }),
        ).rejects.toThrow();
      await expect(
        fixture.tags.createTag({
          ...context(s, s.builder),
          key: 'builder',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      expect(await fixture.tags.listTags(context(s, s.viewer))).toEqual({
        items: [],
        nextId: null,
      });
    });

    it('discovers archived assignments with current organization revisions before UUID paging', async () => {
      const s = await fixture.scope(),
        selected = await tag(s);
      const workflows = await Promise.all([
        s.workflow('active'),
        s.workflow('archived'),
        s.workflow('third'),
      ]);
      for (const workflowId of workflows)
        await fixture.tags.replaceTags({
          ...context(s),
          workflowId,
          tagIds: [selected.id],
          expectedOrganizationRevision: 1,
          idempotencyKey: randomUUID(),
        });
      const archived = workflows[1];
      await fixture.authoring.transitionWorkflowLifecycle({
        ...context(s),
        workflowId: archived,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const first = await fixture.tags.listTagAssignments({
        ...context(s),
        tagId: selected.id,
        limit: 2,
      });
      const expected = [...workflows]
        .sort()
        .map((workflowId) => ({ workflowId, organizationRevision: 2 }));
      expect(first.items).toEqual(expected.slice(0, 2));
      if (first.nextId === null)
        throw new Error('Expected assignment continuation');
      const last = await fixture.tags.listTagAssignments({
        ...context(s),
        tagId: selected.id,
        limit: 2,
        afterId: first.nextId,
      });
      expect([...first.items, ...last.items]).toEqual(expected);
      expect(last.nextId).toBeNull();
      expect(Object.keys(first.items[0] ?? {}).sort()).toEqual([
        'organizationRevision',
        'workflowId',
      ]);
      expect(
        await fixture.tags.detachTag({
          ...context(s),
          tagId: selected.id,
          workflowId: archived,
          expectedOrganizationRevision: 2,
          idempotencyKey: randomUUID(),
        }),
      ).toEqual({
        workflowId: archived,
        organizationRevision: 3,
        replayed: false,
      });
    });

    it('uses generic not-found for missing/foreign discovery and denies non-admin discovery', async () => {
      const s = await fixture.scope(),
        foreign = await fixture.scope(),
        selected = await tag(s),
        other = await tag(foreign);
      for (const tagId of [randomUUID(), other.id])
        await expect(
          fixture.tags.listTagAssignments({ ...context(s), tagId }),
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      for (const actor of [s.viewer, s.builder])
        await expect(
          fixture.tags.listTagAssignments({
            ...context(s, actor),
            tagId: selected.id,
          }),
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      expect((await fixture.tags.listTags(context(s))).items).toEqual([
        selected,
      ]);
    });

    it('rechecks authority on the next page and denies suspended readers', async () => {
      const s = await fixture.scope();
      await Promise.all(['one', 'two'].map((key) => tag(s, key)));
      const first = await fixture.tags.listTags({
        ...context(s, s.viewer),
        limit: 1,
      });
      if (first.nextId === null) throw new Error('Expected continuation');
      await owner(
        s,
        "update app.workspace_memberships set status='suspended',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
        [s.workspace, s.viewer],
      );
      await expect(
        fixture.tags.listTags({
          ...context(s, s.viewer),
          limit: 1,
          afterId: first.nextId,
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    });

    it('bump no-op replacement once, maps stale/collision errors and recovers before writer/selection checks', async () => {
      const s = await fixture.scope(),
        workflowId = await s.workflow(),
        selected = await tag(s),
        other = await tag(s, 'other');
      await expect(
        fixture.tags.renameTag({
          ...context(s),
          tagId: selected.id,
          key: other.key,
          expectedTagRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowTagConflictError',
        kind: 'key',
      });
      const key = randomUUID(),
        command = {
          ...context(s),
          workflowId,
          tagIds: [selected.id],
          expectedOrganizationRevision: 1,
          idempotencyKey: key,
        };
      const first = await fixture.tags.replaceTags(command);
      expect(first.organizationRevision).toBe(2);
      expect(
        (
          await fixture.tags.replaceTags({
            ...command,
            expectedOrganizationRevision: 2,
            idempotencyKey: randomUUID(),
          })
        ).organizationRevision,
      ).toBe(3);
      await expect(
        fixture.tags.replaceTags({ ...command, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({
        name: 'WorkflowTagConflictError',
        kind: 'organization_revision',
      });
      await expect(
        fixture.tags.replaceTags({ ...command, tagIds: [] }),
      ).rejects.toBeInstanceOf(WorkflowIdempotencyConflictError);
      await fixture.tags.deleteTag({
        ...context(s),
        tagId: selected.id,
        expectedTagRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await owner(
        s,
        'update app.workflow_organization_rollout set writes_enabled=false',
      );
      try {
        expect(await fixture.tags.replaceTags(command)).toEqual({
          ...first,
          replayed: true,
        });
        await expect(
          fixture.tags.createTag({
            ...context(s),
            key: 'disabled',
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(WorkflowOrganizationUnavailableError);
        expect((await fixture.tags.listTags(context(s))).items).toEqual([
          other,
        ]);
      } finally {
        await owner(
          s,
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
      }
    });

    it('rejects overflow delete without changing assignments, then explicit detach permits bounded deletion', async () => {
      const s = await fixture.scope(),
        selected = await tag(s);
      const workflows: string[] = [];
      for (let index = 0; index < 51; index++) {
        const workflowId = await s.workflow(`overflow-${String(index)}`);
        workflows.push(workflowId);
        await fixture.tags.replaceTags({
          ...context(s),
          workflowId,
          tagIds: [selected.id],
          expectedOrganizationRevision: 1,
          idempotencyKey: randomUUID(),
        });
      }
      await expect(
        fixture.tags.deleteTag({
          ...context(s),
          tagId: selected.id,
          expectedTagRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowTagConflictError',
        kind: 'delete_overflow',
      } satisfies Partial<WorkflowTagConflictError>);
      expect(
        (
          await fixture.tags.listTagAssignments({
            ...context(s),
            tagId: selected.id,
            limit: 100,
          })
        ).items,
      ).toHaveLength(51);
      const workflowId = workflows[0];
      if (workflowId === undefined)
        throw new Error('Expected cleanup workflow');
      await fixture.tags.detachTag({
        ...context(s),
        tagId: selected.id,
        workflowId,
        expectedOrganizationRevision: 2,
        idempotencyKey: randomUUID(),
      });
      expect(
        await fixture.tags.deleteTag({
          ...context(s),
          tagId: selected.id,
          expectedTagRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).toEqual({
        tagId: selected.id,
        deleted: true,
        detachedWorkflowCount: 50,
        replayed: false,
      });
      await expect(
        fixture.tags.listTagAssignments({ ...context(s), tagId: selected.id }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    });
  },
);

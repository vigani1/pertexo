import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commandKey,
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';
import { purgeWorkspace } from './support/workspace-purge.js';

type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;
interface Result {
  tag?: { id: string; key: string; revision: number };
  organizationRevision?: number;
  tagIds?: readonly string[];
  isFavorite?: boolean;
  replayed: boolean;
  detachedWorkflowCount?: number;
}
let fixture: OrganizationOwnedFixture;
let fixtureCreated = false;
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error('Missing expected F07 fixture value');
  return value;
}
function api<T>(
  s: Scope,
  actor: string,
  work: (client: PoolClient) => Promise<T>,
) {
  return fixture.transaction(fixture.api, s.workspace, actor, work);
}
function owner<Row extends Record<string, unknown> = Record<string, unknown>>(
  s: Scope,
  text: string,
  values: unknown[] = [],
) {
  return fixture.transaction(fixture.owner, s.workspace, s.actor, (client) =>
    client.query<Row>(text, values),
  );
}
function tag(
  s: Scope,
  operation: 'tag.create' | 'tag.rename' | 'tag.delete',
  id: string | null,
  body: Readonly<{ key?: string; expectedTagRevision?: number }>,
  key = commandKey(),
  actor = s.actor,
): Promise<Result> {
  const command = {
    workspaceId: s.workspace,
    actorId: actor,
    idempotencyKey: key,
  };
  if (operation === 'tag.create')
    return fixture.tags.createTag({ ...command, key: body.key ?? '' });
  const tagId = required(id ?? undefined);
  const expectedTagRevision = body.expectedTagRevision ?? 0;
  return operation === 'tag.rename'
    ? fixture.tags.renameTag({
        ...command,
        tagId,
        key: body.key ?? '',
        expectedTagRevision,
      })
    : fixture.tags.deleteTag({ ...command, tagId, expectedTagRevision });
}
async function createTag(
  s: Scope,
  name = `tag-${randomBytes(4).toString('hex')}`,
) {
  const result = await tag(s, 'tag.create', null, { key: name });
  if (!result.tag) throw new Error('Missing created tag');
  return result.tag;
}
function assignment(
  s: Scope,
  workflow: string,
  ids: string[],
  revision = 1,
  key = commandKey(),
  actor = s.actor,
): Promise<Result> {
  return fixture.tags.replaceTags({
    workspaceId: s.workspace,
    actorId: actor,
    idempotencyKey: key,
    workflowId: workflow,
    tagIds: ids,
    expectedOrganizationRevision: revision,
  });
}
function favorite(s: Scope, workflow: string, value: boolean) {
  return fixture.favorites.setFavorite({
    workspaceId: s.workspace,
    actorId: s.viewer,
    workflowId: workflow,
    favorite: value,
  });
}
async function favoritesOf(s: Scope, actor: string) {
  return (
    await owner<{ workflow_id: string }>(
      s,
      'select workflow_id from app.workflow_favorites where workspace_id=$1 and actor_id=$2',
      [s.workspace, actor],
    )
  ).rows.map((row) => row.workflow_id);
}
async function removeAndRejoin(s: Scope) {
  await fixture.identity.removeWorkspaceMember({
    workspaceId: s.workspace,
    actorUserId: s.actor,
    targetUserId: s.viewer,
    expectedRoleRevision: 1,
    idempotencyKey: randomUUID(),
  });
  // Privileged membership fixture projects the existing invitation rejoin shape;
  // this does not claim live invitation transport qualification.
  await owner(
    s,
    "update app.workspace_memberships set status='active',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
    [s.workspace, s.viewer],
  );
}

describe.skipIf(!organizationFixtureEnabled)(
  'owned PostgreSQL organization commands',
  () => {
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      fixtureCreated = true;
    }, 120000);
    afterAll(async () => {
      if (fixtureCreated) await fixture.close();
    }, 30000);

    it('normalizes exact ASCII command identity, preserves UUID on rename, and fences stale commands', async () => {
      const s = await fixture.scope(),
        key = commandKey();
      const first = await tag(s, 'tag.create', null, { key: '  OPS-2  ' }, key);
      expect(first.tag?.key).toBe('ops-2');
      expect(await tag(s, 'tag.create', null, { key: 'ops-2' }, key)).toEqual({
        ...first,
        replayed: true,
      });
      await expect(
        tag(s, 'tag.create', null, { key: 'Ops-2' }),
      ).rejects.toMatchObject({ kind: 'key' });
      if (!first.tag) throw new Error('Missing tag');
      const renamed = await tag(s, 'tag.rename', first.tag.id, {
        key: 'ops-new',
        expectedTagRevision: 1,
      });
      expect(renamed.tag).toEqual({
        id: first.tag.id,
        key: 'ops-new',
        revision: 2,
      });
      await expect(
        tag(s, 'tag.rename', first.tag.id, {
          key: 'lost',
          expectedTagRevision: 1,
        }),
      ).rejects.toMatchObject({ kind: 'tag_revision' });
      await expect(
        tag(s, 'tag.create', null, { key: 'different' }, key),
      ).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
    });

    it.each([
      'ops_2',
      '-ops',
      'ops--2',
      'équipe',
      '\tops\t',
      'ops\n',
      'x'.repeat(33),
      '',
    ])('rejects noncanonical tag input %j', async (key) => {
      const s = await fixture.scope();
      await expect(tag(s, 'tag.create', null, { key })).rejects.toMatchObject({
        name: 'ZodError',
      });
      expect(
        (
          await owner(
            s,
            'select * from app.idempotency_records where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
    });

    it('canonicalizes tag selections, bounds sixteen, bumps no-ops once and replays after the selection changes', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow();
      const tags = await Promise.all(
        Array.from({ length: 17 }, (_, index) =>
          createTag(s, `tag-${String(index)}`),
        ),
      );
      await expect(
        assignment(
          s,
          workflow,
          tags.map(({ id }) => id),
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
      await expect(
        assignment(s, workflow, [required(tags[0]).id, required(tags[0]).id]),
      ).rejects.toMatchObject({ name: 'ZodError' });
      const key = commandKey(),
        selected = tags.slice(0, 16).map(({ id }) => id);
      expect(
        await assignment(s, workflow, [...selected].reverse(), 1, key),
      ).toMatchObject({
        organizationRevision: 2,
        tagIds: [...selected].sort(),
      });
      expect(await assignment(s, workflow, selected, 1, key)).toMatchObject({
        replayed: true,
        organizationRevision: 2,
      });
      await expect(assignment(s, workflow, [], 1)).rejects.toMatchObject({
        kind: 'organization_revision',
      });
      expect(await assignment(s, workflow, selected, 2)).toMatchObject({
        organizationRevision: 3,
      });
      const deleted = required(tags[0]);
      await tag(s, 'tag.delete', deleted.id, { expectedTagRevision: 1 });
      expect(await assignment(s, workflow, selected, 1, key)).toMatchObject({
        replayed: true,
        organizationRevision: 2,
      });
    });

    it('deletes exactly fifty assignments atomically; fifty-first conflicts without any revision mutation; archived cleanup works', async () => {
      const s = await fixture.scope(),
        t = await createTag(s);
      const workflows: string[] = [];
      for (let index = 0; index < 51; index++) {
        const id = await s.workflow(`Bounded workflow ${String(index)}`);
        workflows.push(id);
        await assignment(s, id, [t.id]);
      }
      const before = (
        await owner(
          s,
          'select workflow_id,revision::int revision from app.workflow_organization_state where workspace_id=$1 order by workflow_id',
          [s.workspace],
        )
      ).rows;
      await expect(
        tag(s, 'tag.delete', t.id, { expectedTagRevision: 1 }),
      ).rejects.toMatchObject({ kind: 'delete_overflow' });
      expect(
        (
          await owner(
            s,
            'select workflow_id,revision::int revision from app.workflow_organization_state where workspace_id=$1 order by workflow_id',
            [s.workspace],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await owner(
            s,
            'select count(*)::int count from app.workflow_tag_assignments where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ count: 51 }]);
      const archived = required(workflows[0]);
      await fixture.authoring.transitionWorkflowLifecycle({
        workspaceId: s.workspace,
        actorId: s.actor,
        workflowId: archived,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(assignment(s, archived, [], 2)).rejects.toMatchObject({
        kind: 'lifecycle',
      });
      const detached = await fixture.tags.detachTag({
        workspaceId: s.workspace,
        actorId: s.actor,
        idempotencyKey: commandKey(),
        workflowId: archived,
        tagId: t.id,
        expectedOrganizationRevision: 2,
      });
      expect(detached).toMatchObject({ organizationRevision: 3 });
      expect(
        await tag(s, 'tag.delete', t.id, { expectedTagRevision: 1 }),
      ).toMatchObject({ detachedWorkflowCount: 50 });
      expect(
        (
          await owner(
            s,
            'select revision::int revision from app.workflow_organization_state where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual(Array.from({ length: 51 }, () => ({ revision: 3 })));
      expect(
        (
          await owner(
            s,
            'select * from app.workflow_tag_assignments where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
    });

    it('checks current roles on processing/replay and sanitizes foreign workflow/tag IDs', async () => {
      const s = await fixture.scope(),
        other = await fixture.scope(),
        workflow = await s.workflow(),
        foreign = await other.workflow();
      const t = await createTag(s),
        foreignTag = await createTag(other);
      await expect(
        tag(s, 'tag.create', null, { key: 'denied' }, commandKey(), s.viewer),
      ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
      await expect(
        tag(
          s,
          'tag.rename',
          t.id,
          { key: 'denied', expectedTagRevision: 1 },
          commandKey(),
          s.builder,
        ),
      ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
      await expect(
        assignment(s, workflow, [t.id], 1, commandKey(), s.viewer),
      ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
      expect(
        await assignment(s, workflow, [t.id], 1, commandKey(), s.builder),
      ).toMatchObject({ organizationRevision: 2 });
      await expect(
        assignment(s, workflow, [foreignTag.id], 2),
      ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
      await expect(assignment(s, foreign, [])).rejects.toMatchObject({
        name: 'WorkflowNotFoundError',
      });
      const key = commandKey();
      await assignment(s, workflow, [], 2, key, s.builder);
      await owner(
        s,
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [s.workspace, s.builder],
      );
      await expect(
        assignment(s, workflow, [], 2, key, s.builder),
      ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    });

    it('serializes the workspace vocabulary cap of 256 and keeps other-workspace keys independent', async () => {
      const s = await fixture.scope(),
        other = await fixture.scope();
      for (let index = 0; index < 256; index++)
        await createTag(s, `quota-${String(index)}`);
      await expect(createTag(s, 'overflow')).rejects.toMatchObject({
        kind: 'limit',
      });
      expect(await createTag(other, 'quota-0')).toMatchObject({
        key: 'quota-0',
        revision: 1,
      });
      expect(
        (
          await owner(
            s,
            'select count(*)::int count from app.workflow_tags where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ count: 256 }]);
    });

    it('keeps favorites private to each member, also on archived workflows, without audit or receipts', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow();
      await fixture.authoring.transitionWorkflowLifecycle({
        workspaceId: s.workspace,
        actorId: s.actor,
        workflowId: workflow,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      expect(await favorite(s, workflow, true)).toEqual({ isFavorite: true });
      expect(await favorite(s, workflow, true)).toEqual({ isFavorite: true });
      expect(await favoritesOf(s, s.viewer)).toEqual([workflow]);
      expect(await favoritesOf(s, s.actor)).toEqual([]);
      for (const table of ['audit_events', 'idempotency_records'])
        expect(
          (
            await owner(
              s,
              `select 1 from app.${table} where workspace_id=$1 and ${table === 'audit_events' ? 'action' : 'operation'} like '%favorite%'`,
              [s.workspace],
            )
          ).rows,
        ).toEqual([]);
    });

    it("keeps a suspended member's favorites and drops a removed member's", async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow();
      await favorite(s, workflow, true);
      for (const status of ['suspended', 'active'])
        await owner(
          s,
          'update app.workspace_memberships set status=$3 where workspace_id=$1 and user_id=$2',
          [s.workspace, s.viewer, status],
        );
      expect(await favoritesOf(s, s.viewer)).toEqual([workflow]);
      await removeAndRejoin(s);
      expect(await favoritesOf(s, s.viewer)).toEqual([]);
    });

    it('refuses favorites outside the workspace and scopes tags to it', async () => {
      const s = await fixture.scope();
      await createTag(s);
      const other = await fixture.scope(),
        foreign = await other.workflow();
      await expect(favorite(s, foreign, true)).rejects.toMatchObject({
        name: 'WorkflowNotFoundError',
      });
      expect(
        (
          await api(other, other.actor, (client) =>
            client.query('select * from app.workflow_tags'),
          )
        ).rows,
      ).toEqual([]);
    });

    it('lets one of two concurrent tag replacements win, without lost assignments', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        firstTag = await createTag(s),
        secondTag = await createTag(s);
      const results = await Promise.allSettled([
        assignment(s, workflow, [firstTag.id], 1, commandKey(), s.builder),
        assignment(s, workflow, [secondTag.id], 1, commandKey(), s.builder),
      ]);
      const won = results.findIndex((result) => result.status === 'fulfilled');
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const lost = results[1 - won];
      expect(
        lost?.status === 'rejected' ? lost.reason : undefined,
      ).toMatchObject({ kind: 'organization_revision' });
      expect(
        (
          await owner(
            s,
            'select tag_id from app.workflow_tag_assignments where workspace_id=$1 and workflow_id=$2',
            [s.workspace, workflow],
          )
        ).rows,
      ).toEqual([{ tag_id: (won === 0 ? firstTag : secondTag).id }]);
    });

    it('purges organization records in pages before the workflows they describe', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        t = await createTag(s);
      await assignment(s, workflow, [t.id]);
      const stores = fixture.folderStores();
      const command = () => ({
        workspaceId: s.workspace,
        actorId: s.actor,
        idempotencyKey: commandKey(),
      });
      const folders: string[] = [];
      for (const name of ['root', 'child', 'leaf'])
        folders.push(
          (
            await stores.folders.createFolder({
              ...command(),
              name,
              parentId: folders.at(-1) ?? null,
            })
          ).folder.id,
        );
      await stores.folders.placeWorkflow({
        ...command(),
        workflowId: workflow,
        folderId: required(folders.at(-1)),
        expectedOrganizationRevision: 2,
      });
      await stores.batches.admitBatch({
        ...command(),
        request: {
          operation: 'move',
          folderId: null,
          items: [{ workflowId: workflow, expectedOrganizationRevision: 3 }],
        },
      });
      await favorite(s, workflow, true);
      const surfaces = [
        'workflow_favorites',
        'workflow_tag_assignments',
        'workflow_organization_state',
        'workflow_folders',
        'workflow_tags',
      ];
      const steps = await purgeWorkspace({
        adminUrl: fixture.urls.admin,
        maintenanceUrl: fixture.urls.maintenance,
        workspaceId: s.workspace,
        pageSize: 2,
      });
      expect(new Set(steps.filter((step) => surfaces.includes(step)))).toEqual(
        new Set(surfaces),
      );
      // Organization rows go before the workflows they describe.
      expect(
        Math.max(...surfaces.map((surface) => steps.lastIndexOf(surface))),
      ).toBeLessThan(steps.indexOf('workflows'));
    });
  },
);

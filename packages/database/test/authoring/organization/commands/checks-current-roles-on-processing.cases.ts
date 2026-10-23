import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { commandKey } from '../owned.fixture.js';
import { purgeWorkspace } from '../../../support/workspace-purge.js';
import {
  fixture,
  required,
  api,
  owner,
  tag,
  createTag,
  assignment,
  favorite,
  favoritesOf,
  removeAndRejoin,
} from './fixture.js';

export function registerChecksCurrentRolesOnProcessing(): void {
  it('checks current roles on processing/replay and sanitizes foreign workflow/tag IDs', async () => {
    const s = await fixture.scope(),
      other = await fixture.scope(),
      workflow = await s.workflow(),
      foreign = await other.workflow();
    const t = await createTag(s),
      foreignTag = await createTag(other);
    await expect(
      tag(s, 'tag.create', {
        id: null,
        body: { key: 'denied' },
        key: commandKey(),
        actor: s.viewer,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    await expect(
      tag(s, 'tag.rename', {
        id: t.id,
        body: { key: 'denied', expectedTagRevision: 1 },
        key: commandKey(),
        actor: s.builder,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    await expect(
      assignment(s, workflow, {
        ids: [t.id],
        revision: 1,
        key: commandKey(),
        actor: s.viewer,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    expect(
      await assignment(s, workflow, {
        ids: [t.id],
        revision: 1,
        key: commandKey(),
        actor: s.builder,
      }),
    ).toMatchObject({ organizationRevision: 2 });
    await expect(
      assignment(s, workflow, { ids: [foreignTag.id], revision: 2 }),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    await expect(assignment(s, foreign, { ids: [] })).rejects.toMatchObject({
      name: 'WorkflowNotFoundError',
    });
    const key = commandKey();
    await assignment(s, workflow, {
      ids: [],
      revision: 2,
      key: key,
      actor: s.builder,
    });
    await owner(
      s,
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [s.workspace, s.builder],
    );
    await expect(
      assignment(s, workflow, {
        ids: [],
        revision: 2,
        key: key,
        actor: s.builder,
      }),
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
      assignment(s, workflow, {
        ids: [firstTag.id],
        revision: 1,
        key: commandKey(),
        actor: s.builder,
      }),
      assignment(s, workflow, {
        ids: [secondTag.id],
        revision: 1,
        key: commandKey(),
        actor: s.builder,
      }),
    ]);
    const won = results.findIndex((result) => result.status === 'fulfilled');
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const lost = results[1 - won];
    expect(lost?.status === 'rejected' ? lost.reason : undefined).toMatchObject(
      { kind: 'organization_revision' },
    );
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
    await assignment(s, workflow, { ids: [t.id] });
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
}

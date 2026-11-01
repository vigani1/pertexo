import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { commandKey } from '../owned.fixture.js';

import {
  fixture,
  required,
  owner,
  tag,
  createTag,
  assignment,
} from './fixture.js';

export function registerNormalizesExactASCIICommandIdentity(): void {
  it('normalizes exact ASCII command identity, preserves UUID on rename, and fences stale commands', async () => {
    const s = await fixture.scope(),
      key = commandKey();
    const first = await tag(s, 'tag.create', {
      id: null,
      body: { key: '  OPS-2  ' },
      key: key,
    });
    expect(first.tag?.key).toBe('ops-2');
    expect(
      await tag(s, 'tag.create', {
        id: null,
        body: { key: 'ops-2' },
        key: key,
      }),
    ).toEqual({
      ...first,
      replayed: true,
    });
    await expect(
      tag(s, 'tag.create', { id: null, body: { key: 'Ops-2' } }),
    ).rejects.toMatchObject({ kind: 'key' });
    if (!first.tag) throw new Error('Missing tag');
    const renamed = await tag(s, 'tag.rename', {
      id: first.tag.id,
      body: {
        key: 'ops-new',
        expectedTagRevision: 1,
      },
    });
    expect(renamed.tag).toEqual({
      id: first.tag.id,
      key: 'ops-new',
      revision: 2,
    });
    await expect(
      tag(s, 'tag.rename', {
        id: first.tag.id,
        body: {
          key: 'lost',
          expectedTagRevision: 1,
        },
      }),
    ).rejects.toMatchObject({ kind: 'tag_revision' });
    await expect(
      tag(s, 'tag.create', { id: null, body: { key: 'different' }, key: key }),
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
    await expect(
      tag(s, 'tag.create', { id: null, body: { key } }),
    ).rejects.toMatchObject({
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
      assignment(s, workflow, { ids: tags.map(({ id }) => id) }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      assignment(s, workflow, {
        ids: [required(tags[0]).id, required(tags[0]).id],
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    const key = commandKey(),
      selected = tags.slice(0, 16).map(({ id }) => id);
    expect(
      await assignment(s, workflow, {
        ids: [...selected].reverse(),
        revision: 1,
        key: key,
      }),
    ).toMatchObject({
      organizationRevision: 2,
      tagIds: [...selected].sort(),
    });
    expect(
      await assignment(s, workflow, { ids: selected, revision: 1, key: key }),
    ).toMatchObject({
      replayed: true,
      organizationRevision: 2,
    });
    await expect(
      assignment(s, workflow, { ids: [], revision: 1 }),
    ).rejects.toMatchObject({
      kind: 'organization_revision',
    });
    expect(
      await assignment(s, workflow, { ids: selected, revision: 2 }),
    ).toMatchObject({
      organizationRevision: 3,
    });
    const deleted = required(tags[0]);
    await tag(s, 'tag.delete', {
      id: deleted.id,
      body: { expectedTagRevision: 1 },
    });
    expect(
      await assignment(s, workflow, { ids: selected, revision: 1, key: key }),
    ).toMatchObject({
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
      await assignment(s, id, { ids: [t.id] });
    }
    const before = (
      await owner(
        s,
        'select workflow_id,revision::int revision from app.workflow_organization_state where workspace_id=$1 order by workflow_id',
        [s.workspace],
      )
    ).rows;
    await expect(
      tag(s, 'tag.delete', { id: t.id, body: { expectedTagRevision: 1 } }),
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
    await expect(
      assignment(s, archived, { ids: [], revision: 2 }),
    ).rejects.toMatchObject({
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
      await tag(s, 'tag.delete', {
        id: t.id,
        body: { expectedTagRevision: 1 },
      }),
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
}

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { WorkflowOrganizationBatchRequest } from '../../../../src/authoring/index.js';
import { commandKey } from '../owned.fixture.js';

import {
  fixture,
  create,
  rename,
  moveFolder,
  remove,
  place,
  admit,
  move,
  owner,
} from './fixture.js';

export function registerKeepsSiblingNamesUniqueRegardless(): void {
  it('keeps sibling names unique regardless of ASCII case, checks revisions and replays', async () => {
    const scope = await fixture.scope();
    const first = await create(scope, ' Ops ');
    expect(first).toMatchObject({
      name: 'Ops',
      parentId: null,
      depth: 1,
      revision: 1,
    });
    await expect(create(scope, 'ops')).rejects.toMatchObject({
      kind: 'name',
    });
    const upper = await create(scope, 'Équipe');
    const lower = await create(scope, 'équipe');
    expect(upper.id).not.toBe(lower.id);
    await expect(create(scope, 'bad\tname')).rejects.toMatchObject({
      name: 'ZodError',
    });
    await expect(create(scope, 'é'.repeat(65))).rejects.toMatchObject({
      name: 'ZodError',
    });
    const other = await fixture.scope();
    await expect(create(other, 'foreign', first.id)).rejects.toMatchObject({
      name: 'WorkflowNotFoundError',
    });
    const key = commandKey();
    const renamed = await rename(scope, first.id, {
      name: 'Ops',
      expectedFolderRevision: 1,
      key: key,
    });
    expect(renamed.folder.revision).toBe(2);
    expect(
      await rename(scope, first.id, {
        name: 'Ops',
        expectedFolderRevision: 1,
        key: key,
      }),
    ).toMatchObject({
      folder: { revision: 2 },
      replayed: true,
    });
    await expect(
      rename(scope, first.id, { name: 'New', expectedFolderRevision: 1 }),
    ).rejects.toMatchObject({
      kind: 'revision',
    });
  });

  it('keeps folders at most four deep and refuses cycles without touching descendants', async () => {
    const scope = await fixture.scope();
    const a = await create(scope, 'a'),
      b = await create(scope, 'b', a.id),
      c = await create(scope, 'c', b.id),
      d = await create(scope, 'd', c.id);
    await expect(create(scope, 'too deep', d.id)).rejects.toMatchObject({
      kind: 'hierarchy',
    });
    await expect(moveFolder(scope, a.id, d.id, 1)).rejects.toMatchObject({
      kind: 'hierarchy',
    });
    const other = await create(scope, 'other'),
      child = await create(scope, 'child', other.id);
    await expect(moveFolder(scope, b.id, child.id, 1)).rejects.toMatchObject({
      kind: 'hierarchy',
    });
    expect((await moveFolder(scope, b.id, other.id, 1)).folder).toMatchObject({
      id: b.id,
      revision: 2,
      depth: 2,
    });
    expect(
      (
        await owner(
          scope,
          'select id,revision::int revision from app.workflow_folders where id=$1',
          [d.id],
        )
      ).rows,
    ).toEqual([{ id: d.id, revision: 1 }]);
  });

  it('limits a workspace to 256 folders and lets one of two concurrent siblings win', async () => {
    const scope = await fixture.scope();
    const results = await Promise.allSettled([
      create(scope, 'Shared'),
      create(scope, 'shared'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' ? rejected.reason : undefined,
    ).toMatchObject({ kind: 'name' });
    await owner(
      scope,
      `insert into app.workflow_folders(workspace_id,id,name,name_key)
        select $1,uuidv7(),'f-'||n,'f-'||n from generate_series(1,255) n`,
      [scope.workspace],
    );
    await expect(create(scope, 'overflow')).rejects.toMatchObject({
      kind: 'limit',
    });
    expect(
      (
        await owner(
          scope,
          'select count(*)::int count from app.workflow_folders where workspace_id=$1',
          [scope.workspace],
        )
      ).rows,
    ).toEqual([{ count: 256 }]);
  });

  it('places workflows by organization revision and refuses to delete a folder in use', async () => {
    const scope = await fixture.scope(),
      target = await create(scope, 'target'),
      workflow = await scope.workflow();
    const before = (
      await owner(scope, 'select updated_at from app.workflows where id=$1', [
        workflow,
      ])
    ).rows;
    const key = commandKey();
    expect(
      await place(scope, workflow, {
        folderId: target.id,
        expectedOrganizationRevision: 1,
        key: key,
      }),
    ).toMatchObject({
      folderId: target.id,
      organizationRevision: 2,
      replayed: false,
    });
    expect(
      await place(scope, workflow, {
        folderId: target.id,
        expectedOrganizationRevision: 1,
        key: key,
      }),
    ).toMatchObject({
      organizationRevision: 2,
      replayed: true,
    });
    await expect(
      place(scope, workflow, {
        folderId: null,
        expectedOrganizationRevision: 1,
      }),
    ).rejects.toMatchObject({
      kind: 'organization_revision',
    });
    await expect(remove(scope, target.id)).rejects.toMatchObject({
      kind: 'not_empty',
    });
    await owner(
      scope,
      "update app.workflows set lifecycle_status='archived' where id=$1",
      [workflow],
    );
    await expect(
      place(scope, workflow, {
        folderId: null,
        expectedOrganizationRevision: 2,
        key: commandKey(),
        actor: scope.builder,
      }),
    ).rejects.toMatchObject({ kind: 'lifecycle' });
    await expect(remove(scope, target.id)).rejects.toMatchObject({
      kind: 'not_empty',
    });
    expect(
      await place(scope, workflow, {
        folderId: null,
        expectedOrganizationRevision: 2,
      }),
    ).toMatchObject({
      folderId: null,
      organizationRevision: 3,
    });
    await remove(scope, target.id);
    // Organization changes leave the workflow's own timestamp alone.
    expect(
      (
        await owner(scope, 'select updated_at from app.workflows where id=$1', [
          workflow,
        ])
      ).rows,
    ).toEqual(before);
  });

  it('claims a batch key for its whole request before any item changes', async () => {
    const scope = await fixture.scope(),
      a = await scope.workflow(),
      b = await scope.workflow();
    const key = commandKey();
    const body: WorkflowOrganizationBatchRequest = {
      operation: 'move',
      folderId: null,
      items: [
        { workflowId: a, expectedOrganizationRevision: 1 },
        { workflowId: b, expectedOrganizationRevision: 1 },
      ],
    };
    expect(await admit(scope, key, body)).toEqual({ admitted: true });
    const changes: WorkflowOrganizationBatchRequest[] = [
      { operation: 'replace_tags', tagIds: [], items: body.items },
      move(randomUUID()),
      { ...body, items: [...body.items].reverse() },
      {
        ...body,
        items: [
          { workflowId: a, expectedOrganizationRevision: 2 },
          { workflowId: b, expectedOrganizationRevision: 1 },
        ],
      },
    ];
    for (const changed of changes)
      await expect(admit(scope, key, changed)).rejects.toMatchObject({
        name: 'IdempotencyConflictError',
      });
    expect(
      (
        await owner(
          scope,
          'select count(*)::int count from app.workflow_organization_state where workspace_id=$1',
          [scope.workspace],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
}

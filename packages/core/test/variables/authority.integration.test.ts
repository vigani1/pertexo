import { randomUUID } from 'node:crypto';

import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { admin } from '../../../database/test/lifecycle/calls/fixtures.js';
import { userId } from '../../../database/test/lifecycle/retention.support.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  member,
  scope,
  store,
} from './configuration/fixture.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

/** A workspace whose set is at revision 1, holding RATE = 1. */
async function configured() {
  const f = await fixture();
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 1 },
  });
  return f;
}

const saveAs = (workspaceId: string, actorId: string) =>
  store.replace({
    workspaceId,
    actorId,
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { RATE: 2 },
  });
const usageAs = (workspaceId: string, actorId: string) =>
  store.usage({ workspaceId, actorId, name: 'RATE', limit: 25 });

async function setStatus(workspaceId: string, status: string) {
  await admin.query(
    status === 'suspended' || status === 'active'
      ? 'update app.workspaces set status=$2 where id=$1'
      : `update app.workspaces set status=$2,deletion_requested_at=clock_timestamp(),deletion_requested_by=created_by,
         deletion_reason='Variables test',purge_after=clock_timestamp()+interval '30 days' where id=$1`,
    [workspaceId, status],
  );
}

describe('who reads and who changes', () => {
  it.each(['owner', 'admin', 'builder', 'operator', 'viewer'])(
    'lets a current %s read the values and their usage',
    async (role) => {
      const f = await configured();
      const actorId =
        role === 'owner' ? userId : await member(f.workspaceId, role);
      expect(await store.read({ workspaceId: f.workspaceId, actorId })).toEqual(
        { revision: 1, values: { RATE: 1 }, descriptions: {} },
      );
      expect(await usageAs(f.workspaceId, actorId)).toMatchObject({
        items: [],
      });
    },
  );

  it.each(['owner', 'admin'])('lets a current %s change them', async (role) => {
    const f = await configured();
    const actorId =
      role === 'owner' ? userId : await member(f.workspaceId, role);
    expect(await saveAs(f.workspaceId, actorId)).toMatchObject({ revision: 2 });
  });

  it.each(['builder', 'operator', 'viewer'])(
    'refuses a change from a %s and leaves the set alone',
    async (role) => {
      const f = await configured();
      await expect(
        saveAs(f.workspaceId, await member(f.workspaceId, role)),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      expect((await store.read(scope(f.workspaceId))).values).toEqual({
        RATE: 1,
      });
    },
  );

  it('refuses every action to a member who was removed', async () => {
    const f = await configured();
    const actorId = await member(f.workspaceId, 'admin');
    await admin.query(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [f.workspaceId, actorId],
    );
    for (const action of [
      () => store.read({ workspaceId: f.workspaceId, actorId }),
      () => usageAs(f.workspaceId, actorId),
      () => saveAs(f.workspaceId, actorId),
    ])
      await expect(action()).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it('refuses every action to a suspended user', async () => {
    const f = await configured();
    const actorId = await member(f.workspaceId, 'admin');
    await admin.query("update app.users set status='suspended' where id=$1", [
      actorId,
    ]);
    for (const action of [
      () => store.read({ workspaceId: f.workspaceId, actorId }),
      () => usageAs(f.workspaceId, actorId),
      () => saveAs(f.workspaceId, actorId),
    ])
      await expect(action()).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
});

describe('workspace isolation', () => {
  it('refuses the admin of one workspace every action in another, whose set stays as it was', async () => {
    const mine = await configured();
    const theirs = await fixture();
    const manager = await member(mine.workspaceId, 'admin');
    await store.replace({
      ...scope(theirs.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { THEIRS: 'private' },
    });
    for (const action of [
      () => store.read({ workspaceId: theirs.workspaceId, actorId: manager }),
      () => usageAs(theirs.workspaceId, manager),
      () => saveAs(theirs.workspaceId, manager),
    ])
      await expect(action()).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    expect((await store.read(scope(theirs.workspaceId))).values).toEqual({
      THEIRS: 'private',
    });
    expect((await store.read(scope(mine.workspaceId))).values).toEqual({
      RATE: 1,
    });
  });
});

describe('workspace status', () => {
  it('keeps a suspended workspace readable and refuses its changes', async () => {
    const f = await configured();
    await setStatus(f.workspaceId, 'suspended');
    expect(await store.read(scope(f.workspaceId))).toMatchObject({
      values: { RATE: 1 },
    });
    expect(await usageAs(f.workspaceId, userId)).toMatchObject({ items: [] });
    await expect(saveAs(f.workspaceId, userId)).rejects.toBeInstanceOf(
      WorkspaceAccessDeniedError,
    );
  });

  // A workspace scheduled for deletion can still be restored, so its people can
  // still open it to decide; it changes nothing (ADR 013).
  it('keeps a workspace scheduled for deletion readable and refuses its changes', async () => {
    const f = await configured();
    await setStatus(f.workspaceId, 'pending_deletion');
    expect(await store.read(scope(f.workspaceId))).toMatchObject({
      values: { RATE: 1 },
    });
    expect(await usageAs(f.workspaceId, userId)).toMatchObject({ items: [] });
    await expect(saveAs(f.workspaceId, userId)).rejects.toBeInstanceOf(
      WorkspaceAccessDeniedError,
    );
  });

  it('still finds real references while a workspace is scheduled for deletion', async () => {
    const f = await configured();
    await admin.query(
      'insert into app.workflow_drafts(workspace_id,workflow_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
      [
        f.workspaceId,
        f.parentWorkflowId,
        JSON.stringify({
          settings: {},
          edges: [],
          nodes: [
            {
              id: 'step',
              definition: { key: 'core.set', version: 1 },
              configVersion: 1,
              config: {},
              position: { x: 0, y: 0 },
              inputMappings: {
                rate: { kind: 'workspace_variable', name: 'RATE' },
              },
              connectionRefs: {},
            },
          ],
        }),
        userId,
      ],
    );
    await setStatus(f.workspaceId, 'pending_deletion');
    const page = await usageAs(f.workspaceId, userId);
    expect(page.items.map((item) => item.workflowId)).toEqual([
      f.parentWorkflowId,
    ]);
  });

  it('refuses every action once the purge has started', async () => {
    const f = await configured();
    await setStatus(f.workspaceId, 'purging');
    const actions: readonly (() => Promise<unknown>)[] = [
      () => store.read(scope(f.workspaceId)),
      () => usageAs(f.workspaceId, userId),
      () => saveAs(f.workspaceId, userId),
    ];
    for (const action of actions)
      await expect(action()).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
});

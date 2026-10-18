import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorkflowAuthoringFixtureDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import {
  actorId,
  otherActorId,
  workspaceId,
  workflowId,
  apiUrl,
  parseDatabaseConfig,
  queryAsOwner,
  enforceTestRetention,
  identity,
  emptyGraph,
} from '../../support/workflow-authoring.js';
const database = createWorkflowAuthoringFixtureDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);
function store() {
  if (database.collaboration === undefined)
    throw new Error('Presence store missing');
  return database.collaboration;
}
const scope = () => ({ workspaceId, workflowId, actorId });
const heartbeat = (tabId: string, sequence: number) => ({
  ...scope(),
  tabId,
  sequence,
  editing: true,
  dirty: true,
  baseRevision: 1,
});
beforeAll(async () => {
  await queryAsOwner(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')`,
    [workspaceId, otherActorId],
    workspaceId,
  );
});
afterAll(async () => database.close());
it('keeps newer unsaved state and aggregates separate tabs without letting a clean tab clear it', async () => {
  const first = randomUUID(),
    second = randomUUID();
  expect(await store().heartbeat(heartbeat(first, 2))).toEqual({
    accepted: true,
  });
  expect(
    await store().heartbeat({ ...heartbeat(first, 1), dirty: false }),
  ).toEqual({ accepted: false });
  await store().heartbeat({ ...heartbeat(second, 1), dirty: false });
  const viewed = await store().presence({
    ...scope(),
    actorId: otherActorId,
    tabId: randomUUID(),
  });
  expect(
    viewed.people.find((person) => person.userId === actorId),
  ).toMatchObject({ dirty: true, editing: true, tabCount: 2 });
  expect(
    (await store().presence({ ...scope(), tabId: second })).people.find(
      (person) => person.userId === actorId,
    )?.dirty,
  ).toBe(true);
  await store().leave({ ...scope(), tabId: first });
  await store().leave({ ...scope(), tabId: second });
});
it('hides removed people immediately and refuses their next heartbeat', async () => {
  const tabId = randomUUID();
  await store().heartbeat({ ...heartbeat(tabId, 1), actorId: otherActorId });
  await queryAsOwner(
    `update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2`,
    [workspaceId, otherActorId],
    workspaceId,
  );
  try {
    expect(
      (await store().presence({ ...scope(), tabId: randomUUID() })).people.some(
        (person) => person.userId === otherActorId,
      ),
    ).toBe(false);
    await expect(
      store().heartbeat({ ...heartbeat(tabId, 2), actorId: otherActorId }),
    ).rejects.toThrow('visible');
  } finally {
    await queryAsOwner(
      `update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2`,
      [workspaceId, otherActorId],
      workspaceId,
    );
  }
  await store().leave({ ...scope(), actorId: otherActorId, tabId });
});
it('rechecks edit permission when projecting and renewing an old editing lease', async () => {
  const tabId = randomUUID();
  await store().heartbeat({ ...heartbeat(tabId, 1), actorId: otherActorId });
  await queryAsOwner(
    `update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2`,
    [workspaceId, otherActorId],
    workspaceId,
  );
  try {
    expect(
      (await store().presence({ ...scope(), tabId: randomUUID() })).people.find(
        (person) => person.userId === otherActorId,
      ),
    ).toMatchObject({ editing: false, dirty: false });
    await expect(
      store().heartbeat({ ...heartbeat(tabId, 2), actorId: otherActorId }),
    ).rejects.toThrow('visible');
    await store().heartbeat({
      ...heartbeat(tabId, 3),
      actorId: otherActorId,
      editing: false,
      dirty: false,
      baseRevision: null,
    });
  } finally {
    await queryAsOwner(
      `update app.workspace_memberships set role='builder' where workspace_id=$1 and user_id=$2`,
      [workspaceId, otherActorId],
      workspaceId,
    );
  }
  await store().leave({ ...scope(), actorId: otherActorId, tabId });
});
it('expires disconnected tabs on reads and removes their rows through existing bounded retention', async () => {
  const tabId = randomUUID();
  await store().heartbeat(heartbeat(tabId, 1));
  await queryAsOwner(
    `update app.workflow_presence_leases set last_seen_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where workspace_id=$1 and workflow_id=$2 and tab_id=$3`,
    [workspaceId, workflowId, tabId],
    workspaceId,
  );
  expect(
    (
      await store().presence({
        ...scope(),
        actorId: otherActorId,
        tabId: randomUUID(),
      })
    ).people.some((person) => person.userId === actorId),
  ).toBe(false);
  await enforceTestRetention(1);
  expect(
    await queryAsOwner(
      'select tab_id from app.workflow_presence_leases where workspace_id=$1 and tab_id=$2',
      [workspaceId, tabId],
      workspaceId,
    ),
  ).toEqual([]);
});
it('limits one member to ten tabs while leaving ordinary workflow reads usable', async () => {
  const tabs = Array.from({ length: 10 }, () => randomUUID());
  for (const tab of tabs) await store().heartbeat(heartbeat(tab, 1));
  await expect(
    store().heartbeat(heartbeat(randomUUID(), 1)),
  ).rejects.toMatchObject({ reason: 'limit' });
  expect(
    await database.getWorkflow(workspaceId, workflowId, actorId),
  ).not.toBeNull();
  for (const tab of tabs) await store().leave({ ...scope(), tabId: tab });
});
it('qualifies a hundred people with bounded output and short pool checkouts', async () => {
  const workflow = await database.createWorkflow({
    ...scope(),
    emptyGraph,
    name: 'Presence bound ' + randomUUID(),
    idempotencyKey: randomUUID(),
  });
  for (let index = 0; index < 100; index++) {
    const personId = randomUUID();
    await identity.createUser({
      id: personId,
      email: personId + '@example.test',
      displayName: 'Person ' + String(index) + ' ' + '界'.repeat(240),
    });
    await queryAsOwner(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')`,
      [workspaceId, personId],
      workspaceId,
    );
    await store().heartbeat({
      ...scope(),
      workflowId: workflow.workflowId,
      actorId: personId,
      tabId: randomUUID(),
      sequence: 1,
      editing: false,
      dirty: false,
      baseRevision: null,
    });
  }
  await expect(
    store().heartbeat({
      ...heartbeat(randomUUID(), 1),
      workflowId: workflow.workflowId,
    }),
  ).rejects.toMatchObject({ reason: 'limit' });
  const started = performance.now();
  const [people, ordinary] = await Promise.all([
    store().presence({
      ...scope(),
      workflowId: workflow.workflowId,
      tabId: randomUUID(),
    }),
    database.getWorkflow(workspaceId, workflow.workflowId, actorId),
  ]);
  const bytes = Buffer.byteLength(JSON.stringify(people));
  expect(people.people).toHaveLength(100);
  expect(bytes).toBeLessThan(256 * 1024);
  expect(ordinary).not.toBeNull();
  const idle = await queryAsOwner<{ count: number }>(
    `select count(*)::integer count from pg_stat_activity where datname=current_database() and usename='pertexo_app' and state='idle in transaction'`,
  );
  expect(idle).toEqual([{ count: 0 }]);
  process.stdout.write(
    'PRESENCE_BOUND=' +
      JSON.stringify({
        leases: 100,
        people: people.people.length,
        responseBytes: bytes,
        concurrentReadMs: performance.now() - started,
      }) +
      '\n',
  );
}, 30000);

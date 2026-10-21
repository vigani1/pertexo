import { portableGraphDigest } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorkflowAuthoringFixtureDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import {
  actorId,
  otherActorId,
  workspaceId,
  workflowId,
  otherWorkspaceId,
  otherWorkflowId,
  apiUrl,
  parseDatabaseConfig,
  emptyGraph,
  draftNode,
  testDefinitionCatalog,
  queryAsOwner,
  saveCurrentDraft,
  purgeTestWorkspace,
  apiPool,
  currentRepresentationTag,
} from '../../support/workflow-authoring.js';
const database = createWorkflowAuthoringFixtureDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: testDefinitionCatalog,
    portableCatalog: {
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [],
          validateConfig: () => true,
        },
      ],
    },
  },
);
function store() {
  if (database.collaboration === undefined)
    throw new Error('Discussion store missing');
  return database.collaboration;
}
const scope = () => ({ workspaceId, workflowId, actorId });
const command = () => ({ ...scope(), idempotencyKey: randomUUID() });
beforeAll(async () => {
  await queryAsOwner(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')`,
    [workspaceId, otherActorId],
    workspaceId,
  );
});
afterAll(async () => database.close());
it('lets a reader create and retry a discussion while keeping its canonical text out of audit and receipts', async () => {
  const body = 'Private discussion ' + randomUUID();
  const input = {
    ...command(),
    actorId: otherActorId,
    body,
    mentionUserIds: [actorId],
    stepId: null,
  };
  const created = await store().create(input);
  expect(await store().create(input)).toEqual({ ...created, replayed: true });
  const detail = await store().read({
    ...scope(),
    threadId: created.threadId,
    limit: 20,
  });
  expect(detail.comments).toHaveLength(1);
  expect(detail.comments[0]).toMatchObject({
    body,
    authorId: otherActorId,
    revision: 1,
    mentions: [{ userId: actorId }],
  });
  expect(detail.thread.commentCount).toBe(1);
  const secondary = await queryAsOwner<{ facts: string; receipts: string }>(
    `select coalesce((select string_agg(metadata::text,'') from app.audit_events where workspace_id=$1),'') facts,coalesce((select string_agg(result_ref::text,'') from app.idempotency_records where workspace_id=$1),'') receipts`,
    [workspaceId],
    workspaceId,
  );
  expect(JSON.stringify(secondary)).not.toContain(body);
  expect(
    (await store().people({ ...scope(), actorId: otherActorId, q: '' })).items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: actorId }),
      expect.objectContaining({ userId: otherActorId }),
    ]),
  );
  expect(
    JSON.stringify(
      await store().people({ ...scope(), actorId: otherActorId, q: '' }),
    ),
  ).not.toContain('@example.test');
});
it('allows only the author to edit and makes one concurrent edit win', async () => {
  const created = await store().create({
    ...command(),
    actorId: otherActorId,
    body: 'Original',
    mentionUserIds: [],
    stepId: null,
  });
  if (created.commentId === null) throw new Error('Comment missing');
  await expect(
    store().edit({
      ...command(),
      threadId: created.threadId,
      commentId: created.commentId,
      expectedRevision: 1,
      body: 'Owner replacement',
      mentionUserIds: [],
    }),
  ).rejects.toMatchObject({ reason: 'forbidden' });
  const commentId = created.commentId;
  const outcomes = await Promise.allSettled(
    ['First edit', 'Second edit'].map((body) =>
      store().edit({
        ...command(),
        actorId: otherActorId,
        threadId: created.threadId,
        commentId,
        expectedRevision: 1,
        body,
        mentionUserIds: [],
      }),
    ),
  );
  expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(
    1,
  );
  expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(
    1,
  );
  expect(
    (await store().read({ ...scope(), threadId: created.threadId, limit: 20 }))
      .comments[0]?.revision,
  ).toBe(2);
});
it('reopens explicitly and preserves other replies when an opening comment is deleted', async () => {
  const root = await store().create({
    ...command(),
    body: 'Opening ' + randomUUID(),
    mentionUserIds: [],
    stepId: null,
  });
  const reply = await store().reply({
    ...command(),
    actorId: otherActorId,
    threadId: root.threadId,
    body: 'A separate reply',
    mentionUserIds: [],
  });
  let detail = await store().read({
    ...scope(),
    threadId: root.threadId,
    limit: 20,
  });
  await store().setStatus({
    ...command(),
    actorId: otherActorId,
    threadId: root.threadId,
    status: 'resolved',
    expectedRevision: detail.thread.revision,
  });
  await expect(
    store().reply({
      ...command(),
      threadId: root.threadId,
      body: 'Keep this reply',
      mentionUserIds: [],
    }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  detail = await store().read({
    ...scope(),
    threadId: root.threadId,
    limit: 20,
  });
  await store().setStatus({
    ...command(),
    threadId: root.threadId,
    status: 'open',
    expectedRevision: detail.thread.revision,
  });
  if (root.commentId === null || reply.commentId === null)
    throw new Error('Comment missing');
  await store().remove({
    ...command(),
    threadId: root.threadId,
    commentId: root.commentId,
    expectedRevision: 1,
  });
  detail = await store().read({
    ...scope(),
    threadId: root.threadId,
    limit: 20,
  });
  expect(detail.thread.commentCount).toBe(1);
  expect(detail.comments.map((comment) => comment.body)).toEqual([
    'A separate reply',
  ]);
  const deletion = {
    ...command(),
    actorId: otherActorId,
    threadId: root.threadId,
    commentId: reply.commentId,
    expectedRevision: 1,
  };
  const removed = await store().remove(deletion);
  expect(removed.threadDeleted).toBe(true);
  expect(await store().remove(deletion)).toEqual({
    ...removed,
    replayed: true,
  });
  await expect(
    store().read({ ...scope(), threadId: root.threadId, limit: 20 }),
  ).rejects.toThrow('visible');
});
it('keeps a removed step discussion and excludes comments from portable workflows', async () => {
  const workflow = await database.createWorkflow({
    ...command(),
    name: 'Discussion export ' + randomUUID(),
    emptyGraph,
  });
  const node = { ...draftNode('discussed'), label: 'Before removal' };
  await saveCurrentDraft(database, {
    ...scope(),
    workflowId: workflow.workflowId,
    expectedRevision: 1,
    graphJson: { ...emptyGraph, nodes: [node] },
  });
  const body = 'Not portable ' + randomUUID();
  const thread = await store().create({
    ...command(),
    workflowId: workflow.workflowId,
    body,
    mentionUserIds: [],
    stepId: 'discussed',
  });
  await saveCurrentDraft(database, {
    ...scope(),
    workflowId: workflow.workflowId,
    expectedRevision: 2,
    graphJson: emptyGraph,
  });
  expect(
    (
      await store().read({
        ...scope(),
        workflowId: workflow.workflowId,
        threadId: thread.threadId,
        limit: 20,
      })
    ).thread.stepLabel,
  ).toBe('Before removal');
  await expect(
    store().create({
      ...command(),
      workflowId: workflow.workflowId,
      body: 'New step discussion',
      mentionUserIds: [],
      stepId: 'discussed',
    }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  expect(
    JSON.stringify(
      await database.exportWorkflow({
        ...scope(),
        workflowId: workflow.workflowId,
        source: { kind: 'draft' },
        reviewedGraphDigest: await portableGraphDigest(emptyGraph),
        representationTag: await currentRepresentationTag(
          database,
          workspaceId,
          workflow.workflowId,
          actorId,
        ),
      }),
    ),
  ).not.toContain(body);
});
it('does not expose other workspaces and rolls back a comment with an unavailable mention', async () => {
  await expect(
    store().list({
      ...scope(),
      workflowId: otherWorkflowId,
      limit: 20,
      status: 'all',
      scope: 'all',
    }),
  ).rejects.toThrow('visible');
  const before = (
    await store().list({ ...scope(), limit: 20, status: 'all', scope: 'all' })
  ).items.length;
  await expect(
    store().create({
      ...command(),
      body: 'Invalid recipient',
      mentionUserIds: [randomUUID()],
      stepId: null,
    }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  expect(
    (await store().list({ ...scope(), limit: 20, status: 'all', scope: 'all' }))
      .items,
  ).toHaveLength(before);
  const elsewhere = await store().create({
    ...command(),
    workspaceId: otherWorkspaceId,
    workflowId: otherWorkflowId,
    actorId: otherActorId,
    body: 'Another workspace',
    mentionUserIds: [],
    stepId: null,
  });
  const client = await apiPool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.workspace_id',$1,true)`, [
      workspaceId,
    ]);
    expect(
      (
        await client.query(
          'select id from app.workflow_comment_threads where id=$1',
          [elsewhere.threadId],
        )
      ).rows,
    ).toEqual([]);
    await client.query('rollback');
  } finally {
    client.release();
  }
});
it('paginates discussion history without copying or dropping entries', async () => {
  const root = await store().create({
    ...command(),
    body: 'Page root',
    mentionUserIds: [],
    stepId: null,
  });
  for (let index = 0; index < 22; index++)
    await store().reply({
      ...command(),
      threadId: root.threadId,
      body: 'Reply ' + String(index),
      mentionUserIds: [],
    });
  const first = await store().read({
    ...scope(),
    threadId: root.threadId,
    limit: 20,
  });
  expect(first.comments).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  if (first.nextCursor === null) throw new Error('Comment cursor missing');
  const next = await store().read({
    ...scope(),
    threadId: root.threadId,
    limit: 20,
    before: first.nextCursor,
  });
  expect(next.comments).toHaveLength(3);
  expect(
    new Set([...first.comments, ...next.comments].map((comment) => comment.id))
      .size,
  ).toBe(23);
  const anchor = next.comments[0];
  if (anchor === undefined) throw new Error('Anchor missing');
  expect(
    (
      await store().read({
        ...scope(),
        threadId: root.threadId,
        limit: 20,
        anchor: anchor.id,
      })
    ).comments[0]?.id,
  ).toBe(anchor.id);
});
it('bounds former-step names without splitting complex Unicode labels', async () => {
  const workflow = await database.createWorkflow({
    ...command(),
    name: 'Long label ' + randomUUID(),
    emptyGraph,
  });
  const label = '👩‍💻'.repeat(80);
  await saveCurrentDraft(database, {
    ...scope(),
    workflowId: workflow.workflowId,
    expectedRevision: 1,
    graphJson: { ...emptyGraph, nodes: [{ ...draftNode('long-name'), label }] },
  });
  const root = await store().create({
    ...command(),
    workflowId: workflow.workflowId,
    stepId: 'long-name',
    body: 'Keep the step name',
    mentionUserIds: [],
  });
  const detail = await store().read({
    ...scope(),
    workflowId: workflow.workflowId,
    threadId: root.threadId,
    limit: 20,
  });
  expect(detail.thread.stepLabel).toBe('👩‍💻'.repeat(51) + '…');
  expect(detail.thread.stepLabel?.length).toBeLessThanOrEqual(256);
});
it('purges discussion rows explicitly and leaves the other workspace independent', async () => {
  await store().heartbeat({
    ...scope(),
    tabId: randomUUID(),
    sequence: 1,
    editing: true,
    dirty: true,
    baseRevision: 1,
  });
  const steps = await purgeTestWorkspace(workspaceId, { pageSize: 1 });
  expect(steps).toContain('workflow_comments');
  expect(steps).toContain('workflow_presence_leases');
  expect(
    (
      await store().list({
        workspaceId: otherWorkspaceId,
        workflowId: otherWorkflowId,
        actorId: otherActorId,
        limit: 20,
        status: 'all',
        scope: 'all',
      })
    ).items,
  ).toHaveLength(1);
  expect(
    await queryAsOwner(
      'select count(*)::integer count from app.workflow_comment_threads where workspace_id=$1',
      [workspaceId],
      workspaceId,
    ),
  ).toEqual([{ count: 0 }]);
  // Page-size-one cleanup deliberately spans many short transactions.
}, 30_000);

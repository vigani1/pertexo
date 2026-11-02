import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  actorId,
  authoring,
  currentRepresentationTag,
  draftWrite,
  emptyGraph,
  holdAtWrite,
  identity,
  publicationWrite,
  queryAsOwner,
  saveCurrentDraft,
  workspaceId,
} from '../support/workflow-authoring.js';
import {
  cleanups,
  holdRow,
  namedStore,
} from '../support/workflow-authoring/forced-order.js';
import {
  admin,
  afterAllFixture2,
  beforeAllFixture1,
  builder,
  request,
  requestFor,
  settings,
} from './publication-review/fixture.js';

// Past Postgres's own deadlock timer, and a loaded machine's lock waits.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

const opened = cleanups();
afterEach(() => opened.run());

function flow() {
  const named = namedStore();
  opened.add(() => named.store.close());
  return { reviews: named.store.publicationReviews, ...named };
}

async function holdAt(point: Parameters<typeof holdAtWrite>[0]) {
  const hold = await holdAtWrite(point);
  opened.add(() => hold.remove());
  return hold;
}

async function hold(lockStatement: string, id: string) {
  const held = await holdRow(lockStatement, id);
  opened.add(() => held.release());
  return held;
}

const holdWorkspace = (mode: 'share' | 'update') =>
  hold(`select 1 from app.workspaces where id=$1 for ${mode}`, workspaceId);

const decision = (reviewId: string) => ({
  workspaceId,
  actorId: admin,
  reviewId,
  decision: 'approve' as const,
  idempotencyKey: randomUUID(),
});

const decideClaim = (reviewId: string) => ({
  table: 'idempotency_records',
  operation: 'insert' as const,
  when: `NEW.resource_id = '${reviewId}' and NEW.operation = 'workflow.publication.review.decide'`,
});

const requestInsert = (workflowId: string) => ({
  table: 'workflow_publication_requests',
  operation: 'insert' as const,
  when: `NEW.workflow_id = '${workflowId}'`,
});

const publishedVersions = async (workflowId: string) =>
  queryAsOwner<{ id: string }>(
    'select id from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
    [workspaceId, workflowId],
    workspaceId,
  );

/** Sets the workspace's rule, and puts it back for the next test. */
async function withApproval(required: boolean, space = workspaceId) {
  const set = async (value: boolean) => {
    const { revision } = await settings.settings({
      workspaceId: space,
      actorId,
    });
    await settings.configure({
      workspaceId: space,
      actorId,
      expectedRevision: revision,
      requirePublishApproval: value,
      idempotencyKey: randomUUID(),
    });
  };
  await set(required);
  opened.add(() => set(!required));
}

it('two requests waiting on a fence in flight hold nothing the other wants', async () => {
  const first = flow();
  const second = flow();
  const firstCommand = await requestFor();
  const secondCommand = await requestFor();
  // Any flow in flight holds the workspace row for share. If a request took its
  // own share first and then asked for update, these two would each hold the
  // share and wait for the other's update.
  const fence = await holdWorkspace('share');

  const firstReview = first.reviews.request(firstCommand);
  await first.waiting();
  const secondReview = second.reviews.request(secondCommand);
  await second.waiting();
  await fence.release();

  await expect(firstReview).resolves.toMatchObject({ status: 'pending' });
  await expect(secondReview).resolves.toMatchObject({ status: 'pending' });
});

it('a second request in the workspace waits for the first to commit', async () => {
  const first = flow();
  const second = flow();
  const firstCommand = await requestFor();
  const secondCommand = await requestFor();
  const held = await holdAt(requestInsert(firstCommand.workflowId));

  const firstReview = first.reviews.request(firstCommand);
  await held.reached();
  const secondReview = second.reviews.request(secondCommand);
  await second.waiting();
  await expect(
    queryAsOwner(
      'select 1 from app.workflow_publication_requests where workspace_id=$1 and workflow_id=$2',
      [workspaceId, secondCommand.workflowId],
      workspaceId,
    ),
  ).resolves.toEqual([]);
  await held.release();

  await expect(firstReview).resolves.toMatchObject({ status: 'pending' });
  await expect(secondReview).resolves.toMatchObject({ status: 'pending' });
});

it('a decision in flight finishes with a request waiting behind it', async () => {
  const { review, command } = await request();
  const nextCommand = await requestFor();
  const decider = flow();
  const asking = flow();
  const held = await holdAt(decideClaim(review.id));

  const decided = decider.reviews.decide(decision(review.id));
  await held.reached();
  const next = asking.reviews.request(nextCommand);
  await asking.waiting();
  await held.release();

  // It goes on to take the draft, check the requester and publish, all behind a
  // waiting update on the workspace row.
  await expect(decided).resolves.toMatchObject({
    status: 'approved',
    versionNumber: 1,
  });
  await expect(next).resolves.toMatchObject({ status: 'pending' });
  await expect(publishedVersions(command.workflowId)).resolves.toHaveLength(1);
});

it('a decision queued behind a request for the same workflow takes the workspace first', async () => {
  const { review, command } = await request();
  const asking = flow();
  const decider = flow();
  const workspaceRow = await holdWorkspace('update');

  // The request is first in line for the workspace and will want the workflow
  // next. A decision holding the workflow while it waited would deadlock with it.
  const again = asking.reviews.request({
    ...command,
    idempotencyKey: randomUUID(),
  });
  const refused = expect(again).rejects.toMatchObject({ reason: 'decided' });
  await asking.waiting();
  const decided = decider.reviews.decide(decision(review.id));
  await decider.waiting();
  await workspaceRow.release();

  await refused;
  await expect(decided).resolves.toMatchObject({ status: 'approved' });
});

it('a decision takes the workflow before the draft, as every other command does', async () => {
  const { review, command } = await request();
  const duplicating = flow();
  const decider = flow();
  const representationTag = await currentRepresentationTag(
    authoring,
    workspaceId,
    { scopedWorkflowId: command.workflowId, scopedActorId: builder },
  );
  const workflowRow = await hold(
    'select 1 from app.workflows where id=$1 for update',
    command.workflowId,
  );

  // The duplicate is first in line for the workflow and will want the draft next.
  const copy = duplicating.store.duplicateWorkflow({
    workspaceId,
    actorId: builder,
    workflowId: command.workflowId,
    name: 'A copy',
    source: { kind: 'draft' },
    representationTag,
    idempotencyKey: randomUUID(),
  });
  await duplicating.waiting();
  const decided = decider.reviews.decide(decision(review.id));
  await decider.waiting();
  await workflowRow.release();

  await expect(copy).resolves.toMatchObject({
    workflowId: expect.any(String) as string,
  });
  await expect(decided).resolves.toMatchObject({ status: 'approved' });
});

it('a publish in flight finishes with a request waiting behind it', async () => {
  await withApproval(false);
  const { workflowId, representationTag } = await requestFor(actorId);
  const { workflowId: other, representationTag: otherTag } = await requestFor();
  const publishing = flow();
  const asking = flow();
  const held = await holdAt(publicationWrite('version', workflowId));

  const published = publishing.store.publishWorkflow({
    workspaceId,
    actorId,
    workflowId,
    representationTag,
    requestHash: 'a'.repeat(64),
    idempotencyKey: randomUUID(),
  });
  await held.reached();
  const refused = expect(
    asking.reviews.request({
      workspaceId,
      actorId: builder,
      workflowId: other,
      representationTag: otherTag,
      note: null,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ reason: 'disabled' });
  await asking.waiting();
  await held.release();

  await expect(published).resolves.toMatchObject({ reused: false });
  await refused;
  await expect(publishedVersions(workflowId)).resolves.toHaveLength(1);
});

it('a publish waits behind a request in flight, then answers as the rule says', async () => {
  const command = await requestFor();
  const { workflowId, representationTag } = await requestFor(actorId);
  const asking = flow();
  const publishing = flow();
  const held = await holdAt(requestInsert(command.workflowId));

  const review = asking.reviews.request(command);
  await held.reached();
  const refused = expect(
    publishing.store.publishWorkflow({
      workspaceId,
      actorId,
      workflowId,
      representationTag,
      requestHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ reason: 'required' });
  await publishing.waiting();
  await held.release();

  await expect(review).resolves.toMatchObject({ status: 'pending' });
  await refused;
  await expect(publishedVersions(workflowId)).resolves.toEqual([]);
});

it('a decision waits for a draft save, then sees the draft it no longer reviews', async () => {
  const { review, command } = await request();
  const saving = flow();
  const decider = flow();
  const held = await holdAt(draftWrite(command.workflowId));

  const saved = saveCurrentDraft(saving.store, {
    workspaceId,
    actorId: builder,
    workflowId: command.workflowId,
    expectedRevision: 1,
    graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 3_000 } },
  });
  await held.reached();
  const refused = expect(
    decider.reviews.decide(decision(review.id)),
  ).rejects.toMatchObject({ reason: 'stale' });
  await decider.waiting();
  await held.release();

  await expect(saved).resolves.toMatchObject({ revision: 2 });
  await refused;
  await expect(publishedVersions(command.workflowId)).resolves.toEqual([]);
});

it('one person asks in two workspaces at once without meeting themselves', async () => {
  const secondSpace = await identity.createWorkspaceWithOwner({
    id: randomUUID(),
    name: 'Second reviewed workspace',
    slug: `second-${randomUUID()}`,
    ownerUserId: actorId,
    idempotencyKey: randomUUID(),
  });
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active') returning 1",
    [secondSpace.id, admin],
    secondSpace.id,
  );
  const { revision } = await settings.settings({
    workspaceId: secondSpace.id,
    actorId,
  });
  await settings.configure({
    workspaceId: secondSpace.id,
    actorId,
    expectedRevision: revision,
    requirePublishApproval: true,
    idempotencyKey: randomUUID(),
  });
  const first = flow();
  const second = flow();
  const firstCommand = await requestFor(actorId);
  const secondCommand = await requestFor(actorId, secondSpace.id);
  // Both go on holding this person's user row for share. A flow that then asked
  // for it for update would wait on the other workspace's share, and it on this.
  const person = await hold(
    'select 1 from app.users where id=$1 for share',
    actorId,
  );

  const reviews = await Promise.all([
    first.reviews.request(firstCommand),
    second.reviews.request(secondCommand),
  ]);
  await person.release();

  expect(reviews).toMatchObject([{ status: 'pending' }, { status: 'pending' }]);
});

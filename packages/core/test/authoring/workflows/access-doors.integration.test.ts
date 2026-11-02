import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';
import {
  actorId,
  authoring,
  emptyGraph,
  queryAsOwner,
  workspaceId,
} from '../../support/workflow-authoring.js';
import {
  builder,
  closeWorld,
  graphWith,
  hidden,
  inputCases,
  open,
  openWorld,
  outsider,
  readOnly,
  viewer,
  type Target,
} from './access/world.js';

beforeAll(openWorld, 60_000);
afterAll(closeWorld);

type As = Readonly<{ workspaceId: string; actorId: string }>;
const as = (actor: string): As => ({ workspaceId, actorId: actor });
const key = () => ({ idempotencyKey: randomUUID() });

/** Every command with a workflow's door, ready to pass everything but authority. */
const WRITES: Readonly<
  Record<string, (actor: As, target: Target) => Promise<unknown>>
> = {
  'saving a draft': (actor, { id, tag }) =>
    authoring.saveDraft({
      ...actor,
      workflowId: id,
      graphJson: graphWith('refused'),
      expectedRevision: 1,
      representationTag: tag,
    }),
  'restoring a version': (actor, { id, versionId, tag }) =>
    authoring.restoreWorkflowVersion({
      ...actor,
      ...key(),
      workflowId: id,
      versionId,
      representationTag: tag,
    }),
  publishing: (actor, { id, tag }) =>
    authoring.publishWorkflow({
      ...actor,
      ...key(),
      workflowId: id,
      representationTag: tag,
      requestHash: 'b'.repeat(64),
    }),
  archiving: (actor, { id }) =>
    authoring.transitionWorkflowLifecycle({
      ...actor,
      ...key(),
      workflowId: id,
      command: 'archive',
      expectedLifecycleRevision: 1,
    }),
  renaming: (actor, { id }) =>
    authoring.renameWorkflow({
      ...actor,
      ...key(),
      workflowId: id,
      name: 'Refused',
      expectedNameRevision: 1,
    }),
  'setting concurrency': (actor, { id }) =>
    authoring.concurrency.updateSettings({
      ...actor,
      ...key(),
      workflowId: id,
      limit: 2,
      expectedRevision: 1,
    }),
  'setting an error workflow': (actor, { id }) =>
    authoring.errorWorkflow.updateSettings({
      ...actor,
      ...key(),
      workflowId: id,
      targetWorkflowId: null,
      expectedRevision: 1,
    }),
  'listing error workflow targets': (actor, { id }) =>
    authoring.errorWorkflow.listTargets({ ...actor, workflowId: id }),
  'pinning a sample': (actor, { id }) =>
    authoring.stepSamples.put({
      ...actor,
      ...key(),
      workflowId: id,
      nodeId: 'any',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      source: { kind: 'json', value: {} },
    }),
  'adding an input case': (actor, { id, versionId }) =>
    inputCases.createCase({
      ...actor,
      ...key(),
      workflowId: id,
      workflowVersionId: versionId,
      name: 'Refused',
      input: {},
    }),
  'asking for a review': (actor, { id, tag }) =>
    authoring.publicationReviews.request({
      ...actor,
      ...key(),
      workflowId: id,
      representationTag: tag,
      note: 'Refused',
    }),
  "changing a workflow's auto-pause": (actor, { id }) =>
    authoring.autoPause.updateWorkflowSettings({
      ...actor,
      ...key(),
      workflowId: id,
      enabled: false,
      thresholdOverride: null,
      expectedSettingsRevision: 1,
    }),
  'resuming triggers': (actor, { id }) =>
    authoring.autoPause.resumeWorkflow({
      ...actor,
      ...key(),
      workflowId: id,
      expectedPauseRevision: '0',
    }),
};

const durable = (workflowId: string) =>
  queryAsOwner(
    `select name, lifecycle_status, published_version_id,
       (select revision from app.workflow_drafts d where d.workflow_id=w.id and d.workspace_id=w.workspace_id) draft_revision,
       (select count(*)::int from app.workflow_versions v where v.workflow_id=w.id and v.workspace_id=w.workspace_id) versions,
       (select count(*)::int from app.workflow_comment_threads t where t.workflow_id=w.id and t.workspace_id=w.workspace_id) threads,
       (select count(*)::int from app.workflow_publication_requests r where r.workflow_id=w.id and r.workspace_id=w.workspace_id) reviews
     from app.workflows w where workspace_id=$1 and id=$2`,
    [workspaceId, workflowId],
    workspaceId,
  );

describe.each(Object.entries(WRITES))('%s', (_name, write) => {
  it.each([
    ['someone outside the workspace', () => outsider, () => open],
    ['a viewer', () => viewer, () => open],
    ['a builder, outside their folders', () => builder, () => hidden],
    ['a builder who may only read the folder', () => builder, () => readOnly],
  ])('reads as a missing workflow to %s', async (_who, actor, target) => {
    const before = await durable(target().id);
    await expect(write(as(actor()), target())).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    await expect(durable(target().id)).resolves.toEqual(before);
  });
});

describe('creating a workflow', () => {
  const create = (actor: string) =>
    authoring.createWorkflow({
      ...as(actor),
      ...key(),
      name: 'Refused',
      emptyGraph,
    });

  it.each([
    ['someone outside the workspace', () => outsider],
    ['a viewer', () => viewer],
  ])('reads as a missing workflow to %s', async (_who, actor) => {
    await expect(create(actor())).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('is open to a builder, and they can read what they made', async () => {
    const { workflowId } = await create(builder);
    await expect(
      authoring.getWorkflow(workspaceId, workflowId, builder),
    ).resolves.toMatchObject({ id: workflowId, name: 'Refused' });
  });
});

describe('commenting, which needs only sight of the workflow', () => {
  const comment = (actor: string, target: Target) =>
    authoring.collaboration.create({
      ...as(actor),
      ...key(),
      workflowId: target.id,
      body: 'Looks right',
      mentionUserIds: [],
      stepId: null,
    });

  it('is open to a viewer', async () => {
    const { threadId } = await comment(viewer, open);
    const { items } = await authoring.collaboration.list({
      ...as(viewer),
      workflowId: open.id,
      status: 'all',
      scope: 'all',
      limit: 10,
    });
    expect(items.map(({ id }) => id)).toContain(threadId);
  });

  it('is closed outside the workspace and outside their folders', async () => {
    await expect(comment(outsider, open)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    await expect(comment(builder, hidden)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
});

/** Each read, and what it shows of the workflow a person can reach. */
const READS: Readonly<
  Record<
    string,
    Readonly<{
      read: (actor: As, target: Target) => Promise<unknown>;
      shows: (target: Target) => unknown;
      /** A list or lookup answers with nothing; a door refuses. */
      hiddenAnswer: 'refused' | null | { items: readonly never[] };
    }>
  >
> = {
  'a workflow': {
    read: (actor, { id }) =>
      authoring.getWorkflow(actor.workspaceId, id, actor.actorId),
    shows: ({ id }) => ({ id, name: 'Open' }),
    hiddenAnswer: null,
  },
  'a draft': {
    read: (actor, { id }) =>
      authoring.getDraft(actor.workspaceId, id, actor.actorId),
    shows: () => ({ revision: 1 }),
    hiddenAnswer: null,
  },
  'a version': {
    read: (actor, { id, versionId }) =>
      authoring.getVersion(actor.workspaceId, id, versionId, actor.actorId),
    shows: ({ versionId }) => ({ id: versionId, versionNumber: 1 }),
    hiddenAnswer: null,
  },
  'a draft check': {
    read: (actor, { id }) =>
      authoring.validateDraft(actor.workspaceId, id, actor.actorId),
    shows: () => ({ validation: { ok: true } }),
    hiddenAnswer: null,
  },
  'the concurrency settings': {
    read: (actor, { id }) =>
      authoring.concurrency.readSettings({ ...actor, workflowId: id }),
    shows: () => ({ limit: null, revision: 1, overflow: 'queue' }),
    hiddenAnswer: 'refused',
  },
  'the error workflow': {
    read: (actor, { id }) =>
      authoring.errorWorkflow.readSettings({ ...actor, workflowId: id }),
    shows: () => ({ targetWorkflowId: null, revision: 1 }),
    hiddenAnswer: 'refused',
  },
  "a workflow's auto-pause": {
    read: (actor, { id }) =>
      authoring.autoPause.readWorkflowSettings({ ...actor, workflowId: id }),
    shows: () => ({ enabled: true, thresholdOverride: null }),
    hiddenAnswer: 'refused',
  },
  'the discussions': {
    read: (actor, { id }) =>
      authoring.collaboration.list({
        ...actor,
        workflowId: id,
        limit: 10,
        status: 'all',
        scope: 'all',
      }),
    shows: () => ({ nextCursor: null }),
    hiddenAnswer: 'refused',
  },
  'the input cases': {
    read: (actor, { id }) =>
      inputCases.listCases({ ...actor, workflowId: id, limit: 10 }),
    shows: () => ({ items: [] }),
    hiddenAnswer: 'refused',
  },
  'the pinned samples': {
    read: (actor, { id }) =>
      authoring.stepSamples.list({ ...actor, workflowId: id }),
    shows: () => ({ items: [] }),
    hiddenAnswer: 'refused',
  },
  'the review overview': {
    read: (actor, { id }) =>
      authoring.publicationReviews.overview({ ...actor, workflowId: id }),
    shows: () => ({ required: false, request: null }),
    hiddenAnswer: 'refused',
  },
};

describe.each(Object.entries(READS))(
  '%s',
  (_name, { read, shows, hiddenAnswer }) => {
    it('shows a viewer what is there', async () => {
      await expect(read(as(viewer), open)).resolves.toMatchObject(
        shows(open) as object,
      );
    });

    it('shows someone outside the workspace nothing', async () => {
      await expect(read(as(outsider), open)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    });

    it("shows nothing outside a builder's folders", async () => {
      const answer = read(as(builder), hidden);
      if (hiddenAnswer === 'refused')
        await expect(answer).rejects.toBeInstanceOf(WorkflowNotFoundError);
      else await expect(answer).resolves.toEqual(hiddenAnswer);
    });

    it("shows the owner, whose folders aren't limited, the hidden one", async () => {
      await expect(read(as(actorId), hidden)).resolves.not.toBeNull();
    });
  },
);

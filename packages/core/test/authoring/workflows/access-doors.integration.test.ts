import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkflowNotFoundError } from '../../../src/authoring/workflows/workflow-authoring.errors.js';
import {
  actorId,
  authoring,
  emptyGraph,
  queryAsOwner,
  workspaceId,
} from '../../support/workflow-authoring.js';
import { as, key, READS, WRITES } from './access/doors.js';
import {
  builder,
  closeWorld,
  hidden,
  open,
  openWorld,
  outsider,
  readOnly,
  viewer,
  type Target,
} from './access/world.js';

beforeAll(openWorld, 60_000);
afterAll(closeWorld);

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

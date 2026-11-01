import { portableGraphDigest } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  otherWorkflowId,
  emptyGraph,
  draftNode,
  saveCurrentDraft,
  apiPool,
  currentRepresentationTag,
} from '../../../support/workflow-authoring.js';
import { database, store, scope, command } from './fixture.js';

export function registerKeepsRemovedStepDiscussionExcludes(): void {
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
            { scopedWorkflowId: workflow.workflowId, scopedActorId: actorId },
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
      (
        await store().list({
          ...scope(),
          limit: 20,
          status: 'all',
          scope: 'all',
        })
      ).items,
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
      new Set(
        [...first.comments, ...next.comments].map((comment) => comment.id),
      ).size,
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
      graphJson: {
        ...emptyGraph,
        nodes: [{ ...draftNode('long-name'), label }],
      },
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
}

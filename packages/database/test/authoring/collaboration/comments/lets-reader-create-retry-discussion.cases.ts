import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  otherActorId,
  workspaceId,
  queryAsOwner,
} from '../../../support/workflow-authoring.js';
import { store, scope, command } from './fixture.js';

export function registerLetsReaderCreateRetryDiscussion(): void {
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
      (await store().people({ ...scope(), actorId: otherActorId, q: '' }))
        .items,
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
    expect(
      outcomes.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((value) => value.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      (
        await store().read({
          ...scope(),
          threadId: created.threadId,
          limit: 20,
        })
      ).comments[0]?.revision,
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
}

import { expect, it } from 'vitest';

import type {
  InboxHintSignal,
  InboxHintSource,
} from '../../../src/notifications/inbox-hint-hub.js';

import {
  actorId,
  workspaceId,
  workflowId,
  threadId,
  base,
  thread,
  inboxDatabase,
  hints,
  application,
  session,
} from './fixture.js';

export function registerListsThreadsOpaqueCursorThisList(): void {
  it('lists threads with an opaque cursor that only this list accepts', async () => {
    const database = inboxDatabase();
    const server = await application(database);
    const first = await server.inject({
      method: 'GET',
      url: `${base}?filter=unread&limit=10`,
      headers: session,
    });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ nextCursor: string; items: unknown[] }>();
    expect(page.items).toEqual([thread]);
    expect(database.listThreads).toHaveBeenCalledWith({
      workspaceId,
      actorId,
      filter: 'unread',
      limit: 10,
    });

    const next = await server.inject({
      method: 'GET',
      url: `${base}?filter=unread&after=${encodeURIComponent(page.nextCursor)}`,
      headers: session,
    });
    expect(next.statusCode).toBe(200);
    expect(database.listThreads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: { latestOccurredAt: thread.latestOccurredAt, threadId },
      }),
    );

    const otherFilter = await server.inject({
      method: 'GET',
      url: `${base}?filter=all&after=${encodeURIComponent(page.nextCursor)}`,
      headers: session,
    });
    expect(otherFilter.statusCode).toBe(400);
  });

  it('returns the unread summary and marks reads by the seen revision', async () => {
    const database = inboxDatabase();
    const server = await application(database);
    const summary = await server.inject({
      method: 'GET',
      url: `${base}/summary`,
      headers: session,
    });
    expect(summary.json()).toEqual({ unreadCount: 1, revision: '8' });

    const read = await server.inject({
      method: 'POST',
      url: `${base}/${workflowId}/read`,
      headers: { ...session, 'content-type': 'application/json' },
      payload: { revision: '8' },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ threadId, unread: false, revision: '8' });
    expect(database.markThreadRead).toHaveBeenCalledWith({
      workspaceId,
      actorId,
      threadId,
      revision: '8',
    });

    const all = await server.inject({
      method: 'POST',
      url: `${base}/read-all`,
      headers: { ...session, 'content-type': 'application/json' },
      payload: { revision: '8' },
    });
    expect(all.json()).toEqual({ marked: 1 });
  });

  it('does not disclose a thread the reader cannot see', async () => {
    const database = inboxDatabase();
    database.markThreadRead.mockResolvedValueOnce(undefined);
    const server = await application(database);
    const response = await server.inject({
      method: 'POST',
      url: `${base}/${workflowId}/read`,
      headers: { ...session, 'content-type': 'application/json' },
      payload: { revision: '8' },
    });
    expect(response.statusCode).toBe(404);
  });

  it.each(['builder', 'viewer'] as const)(
    'allows a %s through to its precise personal view',
    async (role) => {
      const database = inboxDatabase();
      const server = await application(database, role);
      const response = await server.inject({
        method: 'GET',
        url: `${base}/summary`,
        headers: session,
      });
      expect(response.statusCode).toBe(200);
      expect(database.readSummary).toHaveBeenCalledWith({
        workspaceId,
        actorId,
      });
    },
  );

  it('rejects a read without a revision or with a recipient', async () => {
    const database = inboxDatabase();
    const server = await application(database, 'operator');
    for (const payload of [{}, { revision: '8', recipientId: actorId }]) {
      const response = await server.inject({
        method: 'POST',
        url: `${base}/read-all`,
        headers: { ...session, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(database.markAllRead).not.toHaveBeenCalled();
  });

  it('streams a ready event and then content-free hints', async () => {
    const signals: InboxHintSignal[] = [{ kind: 'changed', revision: '9' }];
    let closed = false;
    const source: InboxHintSource = {
      ...hints,
      subscribe: () =>
        Promise.resolve({
          close: () => {
            closed = true;
          },
          [Symbol.asyncIterator]: () => ({
            next: () => {
              const value = signals.shift();
              return Promise.resolve(
                value === undefined
                  ? { done: true as const, value: undefined }
                  : { done: false as const, value },
              );
            },
          }),
        }),
    };
    const server = await application(inboxDatabase(), 'owner', source);
    const response = await server.inject({
      method: 'GET',
      url: `${base}/events`,
      headers: session,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.body).toBe(
      'event: inbox.ready\ndata: {"revision":null}\n\n' +
        'event: inbox.changed\ndata: {"revision":"9"}\n\n',
    );
    expect(closed).toBe(true);
  });
}

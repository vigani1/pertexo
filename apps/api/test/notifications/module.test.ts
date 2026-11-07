import { Module } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';
import { SESSION_AUTHORITY } from '../../src/workspaces/index.js';
import { RequestContextStore } from '../../src/platform/http/index.js';
import {
  actorId,
  FakeIdentityModule,
  cleanAppsApiTestNotificationsModuleTestModuleTestTsFixture,
  workspaceId,
  workflowId,
  threadId,
  base,
  thread,
  inboxDatabase,
  hints,
  application,
  session,
  preferenceStore,
} from './notification-module-fixture.js';
import type {
  InboxHintSignal,
  InboxHintSource,
} from '../../src/notifications/inbox-hint-hub.js';
import { NoticePreferencesService } from '../../src/notifications/preferences/notice-preferences.service.js';
import { NoticeConflictError } from '@pertexo/core/inbox';
import { createApplicationSecretEnvelope } from '@pertexo/secrets/server';
import { sealNoticeUnsubscribe } from '@pertexo/core/inbox';
import { randomUUID } from 'node:crypto';

Module({
  providers: [
    {
      provide: RequestContextStore,
      useValue: { setActor: () => undefined, setWorkspace: () => undefined },
    },
    {
      provide: SESSION_AUTHORITY,
      useValue: {
        authenticate: () =>
          Promise.resolve({
            userId: actorId,
            sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            expiresAt: new Date('2030-01-01T00:00:00.000Z'),
            clientMetadata: {},
          }),
      },
    },
    {
      provide: DoubleSubmitCsrfPolicy,
      useValue: { assertMutationAllowed: () => undefined },
    },
  ],
  exports: [RequestContextStore, SESSION_AUTHORITY, DoubleSubmitCsrfPolicy],
})(FakeIdentityModule);
afterEach(cleanAppsApiTestNotificationsModuleTestModuleTestTsFixture);
describe('notifications HTTP surface', () => {
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
});
describe('personal notification HTTP boundaries', () => {
  it('returns availability plainly and validates an exact personal save at the boundary', async () => {
    const store = preferenceStore();
    const server = await application(
      inboxDatabase(),
      'viewer',
      hints,
      new NoticePreferencesService(store, undefined),
    );
    const read = await server.inject({
      method: 'GET',
      url: `${base}/preferences`,
      headers: session,
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    const unavailable = read.json<{
      emailAvailable: boolean;
      emailUnavailableReason: string;
    }>();
    expect(unavailable.emailAvailable).toBe(false);
    expect(unavailable.emailUnavailableReason).toContain('not configured');
    const key = randomUUID();
    const body = { mode: 'off', hour: 9, timeZone: 'UTC', expectedRevision: 0 };
    const saved = await server.inject({
      method: 'PUT',
      url: `${base}/preferences`,
      headers: { ...session, 'idempotency-key': key },
      payload: body,
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    expect(store.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        workspaceId,
        actorId,
        idempotencyKey: key,
      }),
    );
    const invalid = await server.inject({
      method: 'PUT',
      url: `${base}/preferences`,
      headers: { ...session, 'idempotency-key': randomUUID() },
      payload: {
        ...body,
        timeZone: '+02:00',
        toEmail: 'arbitrary@example.test',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.replace).toHaveBeenCalledTimes(1);
    store.replace.mockRejectedValueOnce(new NoticeConflictError());
    const conflict = await server.inject({
      method: 'PUT',
      url: `${base}/preferences`,
      headers: { ...session, 'idempotency-key': randomUUID() },
      payload: body,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'notifications.changed' });
  });

  it('uses explicit subscribe commands and refuses unknown subject types', async () => {
    const store = preferenceStore();
    const server = await application(
      inboxDatabase(),
      'builder',
      hints,
      new NoticePreferencesService(store, undefined),
    );
    const valid = await server.inject({
      method: 'PUT',
      url: `${base}/subjects/workflow/${workflowId}`,
      headers: { ...session, 'idempotency-key': randomUUID() },
      payload: { followed: true, muted: false, expectedRevision: 0 },
    });
    expect(valid.statusCode, valid.payload).toBe(200);
    expect(store.replaceSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        subjectKind: 'workflow',
        subjectId: workflowId,
        followed: true,
        muted: false,
      }),
    );
    const invalid = await server.inject({
      method: 'GET',
      url: `${base}/subjects/workspace/${workspaceId}`,
      headers: session,
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.readSubscription).not.toHaveBeenCalled();
  });

  it('keeps scanner GET inert and scopes explicit public unsubscribe to a sealed capability', async () => {
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 11).toString('base64') },
    });
    const store = preferenceStore();
    const server = await application(
      inboxDatabase(),
      'owner',
      hints,
      new NoticePreferencesService(store, envelope),
    );
    const path = '/v1/notifications/unsubscribe';
    expect((await server.inject({ method: 'GET', url: path })).statusCode).toBe(
      404,
    );
    expect(store.unsubscribe).not.toHaveBeenCalled();
    const claims = {
      workspaceId,
      actorId,
      revision: 3,
      memberRevision: 5,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const token = sealNoticeUnsubscribe(envelope, claims);
    const submitted = await server.inject({
      method: 'POST',
      url: path,
      headers: { 'x-pertexo-unsubscribe-key': token },
      payload: {},
    });
    expect(submitted.statusCode, submitted.payload).toBe(200);
    expect(submitted.headers['referrer-policy']).toBe('no-referrer');
    expect(submitted.json()).toEqual({ unsubscribed: true });
    expect(store.unsubscribe).toHaveBeenCalledWith(claims);
    const bad = await server.inject({
      method: 'POST',
      url: path,
      headers: { 'x-pertexo-unsubscribe-key': 'invalid' },
      payload: {},
    });
    expect(bad.statusCode).toBe(404);
    expect(store.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
it('authorizes anonymous one-click POST by URL alone, ignores bounded form bodies and keeps GET inert', async () => {
  const envelope = createApplicationSecretEnvelope({
    current: { version: 'v1', key: Buffer.alloc(32, 11).toString('base64') },
  });
  const store = preferenceStore();
  const server = await application(
    inboxDatabase(),
    'owner',
    hints,
    new NoticePreferencesService(store, envelope),
  );
  const claims = {
    workspaceId,
    actorId,
    revision: 3,
    memberRevision: 5,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const token = sealNoticeUnsubscribe(envelope, claims);
  const url = `/v1/notifications/unsubscribe/one-click?token=${token}`;
  const get = await server.inject({ method: 'GET', url });
  expect(get.statusCode, get.payload).toBe(303);
  expect(get.headers.location).toBe(`/notifications/unsubscribe#${token}`);
  expect(get.headers['cache-control']).toBe('no-store');
  expect(store.unsubscribe).not.toHaveBeenCalled();
  const submit = (
    payload: string,
    type = 'application/x-www-form-urlencoded',
    target = url,
  ) =>
    server.inject({
      method: 'POST',
      url: target,
      headers: { 'content-type': type },
      payload,
    });
  const accepted = await submit('List-Unsubscribe=One-Click');
  expect(accepted.statusCode, accepted.payload).toBe(200);
  expect(accepted.headers.location).toBeUndefined();
  expect(accepted.json()).toEqual({ unsubscribed: true });
  expect(store.unsubscribe).toHaveBeenLastCalledWith(claims);
  const multipart =
    '--mail-boundary\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--mail-boundary--\r\n';
  expect(
    (await submit(multipart, 'multipart/form-data; boundary=mail-boundary'))
      .statusCode,
  ).toBe(200);
  expect(store.unsubscribe).toHaveBeenCalledTimes(2);
  for (const type of [
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'multipart/form-data; boundary=unused',
  ]) {
    for (const body of [
      '',
      'unparsed',
      'List-Unsubscribe=wrong',
      'List-Unsubscribe=One-Click&List-Unsubscribe=One-Click',
      '__proto__=value',
      'x'.repeat(8192),
    ]) {
      const response = await submit(body, type);
      expect(response.statusCode, `${type}: ${response.payload}`).toBe(200);
      expect(store.unsubscribe).toHaveBeenLastCalledWith(claims);
    }
    expect((await submit('x'.repeat(8193), type)).statusCode).toBe(413);
  }
  const acceptedCount = store.unsubscribe.mock.calls.length;
  expect(
    (await submit('List-Unsubscribe=One-Click&extra=' + 'x'.repeat(8192)))
      .statusCode,
  ).toBe(413);
  expect(
    (await submit('{"List-Unsubscribe":"One-Click"}', 'application/json'))
      .statusCode,
  ).toBe(415);
  expect(
    (
      await submit(
        multipart,
        'multipart/form-data; boundary=mail-boundary',
        '/v1/notifications/unsubscribe',
      )
    ).statusCode,
  ).toBe(415);
  expect(
    (
      await submit(
        'List-Unsubscribe=One-Click',
        undefined,
        '/v1/notifications/unsubscribe/one-click?token=invalid',
      )
    ).statusCode,
  ).toBe(404);
  const expired = sealNoticeUnsubscribe(envelope, {
    ...claims,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  expect(
    (
      await submit(
        'List-Unsubscribe=One-Click',
        undefined,
        `/v1/notifications/unsubscribe/one-click?token=${expired}`,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/v1/notifications/unsubscribe/one-click?token=%0d%0a',
      })
    ).statusCode,
  ).toBe(400);
  const oversized = await submit(
    'List-Unsubscribe=One-Click&extra=' + 'x'.repeat(8192),
  );
  expect(oversized.statusCode).toBe(413);
  expect(oversized.headers['cache-control']).toBe('no-store');
  expect(oversized.headers['referrer-policy']).toBe('no-referrer');
  expect(store.unsubscribe).toHaveBeenCalledTimes(acceptedCount);
});

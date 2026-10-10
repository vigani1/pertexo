import { Module } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { WorkspaceInboxDatabase } from '@pertexo/database/notifications';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';
import { SESSION_AUTHORITY } from '../../src/workspaces/index.js';
import { NotificationsModule } from '../../src/notifications/module.js';
import type {
  InboxHintSignal,
  InboxHintSource,
} from '../../src/notifications/inbox-hint-hub.js';
import { WorkspaceInboxService } from '../../src/notifications/service.js';
import { RequestContextStore } from '../../src/platform/http/index.js';
import { APPLICATION_ERROR_MAPPERS } from '../../src/application-error-mappers.js';
import { HttpPlatformModule } from '../../src/platform/http/http.module.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const base = `/v1/workspaces/${workspaceId}/notifications`;

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}
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

const thread = {
  workflowId,
  workflowName: 'Nightly import',
  kind: 'failed' as const,
  occurrenceCount: 2,
  firstOccurredAt: '2026-09-28T10:00:00.000100Z',
  latestOccurredAt: '2026-09-28T11:00:00.000900Z',
  latestRunId: runId,
  latestFailedStep: null,
  revision: '8',
  unread: true,
};

function inboxDatabase() {
  return {
    listThreads: vi.fn<WorkspaceInboxDatabase['listThreads']>(() =>
      Promise.resolve({
        items: [thread],
        next: { latestOccurredAt: thread.latestOccurredAt, workflowId },
        revision: '8',
      }),
    ),
    readSummary: vi.fn<WorkspaceInboxDatabase['readSummary']>(() =>
      Promise.resolve({ unreadCount: 1, revision: '8' }),
    ),
    markThreadRead: vi.fn<WorkspaceInboxDatabase['markThreadRead']>(() =>
      Promise.resolve({ unread: false, revision: '8' }),
    ),
    markAllRead: vi.fn<WorkspaceInboxDatabase['markAllRead']>(() =>
      Promise.resolve({ marked: 1 }),
    ),
    close: vi.fn(() => Promise.resolve()),
  } satisfies WorkspaceInboxDatabase;
}

function access(role: 'owner' | 'operator' | 'builder' | 'viewer') {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

const hints: InboxHintSource = {
  checkReadiness: () => Promise.resolve(),
  subscribe: () => Promise.reject(new Error('not used')),
  close: () => Promise.resolve(),
};

const openApplications: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(openApplications.splice(0).map((app) => app.close()));
});

async function application(
  database: WorkspaceInboxDatabase,
  role: Parameters<typeof access>[0] = 'owner',
  source: InboxHintSource = hints,
) {
  const testing = await Test.createTestingModule({
    imports: [
      HttpPlatformModule.register(
        { log: () => undefined },
        APPLICATION_ERROR_MAPPERS,
      ),
      NotificationsModule.register(
        new WorkspaceInboxService(database),
        source,
        access(role),
        { module: FakeIdentityModule },
      ),
    ],
  }).compile();
  const adapter = new FastifyAdapter();
  const app = testing.createNestApplication(adapter);
  openApplications.push(app);
  await app.init();
  await adapter.getInstance().ready();
  return adapter.getInstance();
}

const session = { cookie: 'pertexo_session=session-token' };

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
        after: { latestOccurredAt: thread.latestOccurredAt, workflowId },
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
    expect(read.json()).toEqual({ workflowId, unread: false, revision: '8' });
    expect(database.markThreadRead).toHaveBeenCalledWith({
      workspaceId,
      actorId,
      workflowId,
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
    'hides the inbox from a %s without touching the database',
    async (role) => {
      const database = inboxDatabase();
      const server = await application(database, role);
      const response = await server.inject({
        method: 'GET',
        url: `${base}/summary`,
        headers: session,
      });
      expect(response.statusCode).toBe(404);
      expect(database.readSummary).not.toHaveBeenCalled();
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
      'event: inbox.ready\ndata: {"schemaVersion":1,"revision":null}\n\n' +
        'event: inbox.changed\ndata: {"schemaVersion":1,"revision":"9"}\n\n',
    );
    expect(closed).toBe(true);
  });
});

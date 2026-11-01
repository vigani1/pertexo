import type { Role } from '@pertexo/workflow-model';
import { registerWorkflowPortabilityJsonParser } from '../../../src/workflow-authoring/portability/json-parser.js';
import { registerNoticeUnsubscribeTransport } from '../../../src/notifications/preferences/transport.js';
import type { NoticePreferencesService } from '../../../src/notifications/preferences/service.js';
import type { NoticePreferencesStore, WorkspaceInboxStore } from '@pertexo/core/inbox';

import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';

import { NotificationsModule } from '../../../src/notifications/module.js';
import type { InboxHintSource } from '../../../src/notifications/inbox-hint-hub.js';
import { WorkspaceInboxService } from '../../../src/notifications/service.js';

import { APPLICATION_ERROR_MAPPERS } from '../../../src/application-errors.js';
import { HttpPlatformModule } from '../../../src/platform/http/module.js';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const threadId = workflowId;

const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const base = `/v1/workspaces/${workspaceId}/notifications`;

export // Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}

export const thread = {
  id: workflowId,
  noticeKind: 'workflow_failure' as const,
  workflowId,
  workflowName: 'Nightly import',
  kind: 'failed' as const,
  failureDays: [],
  occurrenceCount: 2,
  firstOccurredAt: '2026-09-28T10:00:00.000100Z',
  latestOccurredAt: '2026-09-28T11:00:00.000900Z',
  latestRunId: runId,
  latestFailedStep: null,
  revision: '8',
  unread: true,
};

export function inboxDatabase() {
  return {
    listThreads: vi.fn<WorkspaceInboxStore['listThreads']>(() =>
      Promise.resolve({
        items: [thread],
        next: { latestOccurredAt: thread.latestOccurredAt, threadId },
        revision: '8',
      }),
    ),
    readSummary: vi.fn<WorkspaceInboxStore['readSummary']>(() =>
      Promise.resolve({ unreadCount: 1, revision: '8' }),
    ),
    markThreadRead: vi.fn<WorkspaceInboxStore['markThreadRead']>(() =>
      Promise.resolve({ unread: false, revision: '8' }),
    ),
    markAllRead: vi.fn<WorkspaceInboxStore['markAllRead']>(() =>
      Promise.resolve({ marked: 1 }),
    ),
    close: vi.fn(() => Promise.resolve()),
  } satisfies WorkspaceInboxStore;
}

function access(role: Role) {
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

export const hints: InboxHintSource = {
  checkReadiness: () => Promise.resolve(),
  subscribe: () => Promise.reject(new Error('not used')),
  close: () => Promise.resolve(),
};

const openApplications: { close(): Promise<void> }[] = [];

export async function application(
  database: WorkspaceInboxStore,
  role: Parameters<typeof access>[0] = 'owner',
  source: InboxHintSource = hints,
  preferences?: NoticePreferencesService,
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
        {
          authorization: access(role),
          identityModule: { module: FakeIdentityModule },
          preferences: preferences,
        },
      ),
    ],
  }).compile();
  const adapter = new FastifyAdapter();
  const app = testing.createNestApplication(adapter);
  openApplications.push(app);
  registerWorkflowPortabilityJsonParser(adapter);
  registerNoticeUnsubscribeTransport(adapter);
  await app.init();
  await adapter.getInstance().ready();
  return adapter.getInstance();
}

export const session = { cookie: 'pertexo_session=session-token' };

export function preferenceStore() {
  const schedule = { mode: 'off' as const, hour: 9, timeZone: 'UTC' };
  return {
    read: vi.fn<NoticePreferencesStore['read']>().mockResolvedValue({
      revision: 0,
      mode: null,
      hour: 9,
      timeZone: 'UTC',
      defaults: { ...schedule, revision: 0 },
      effective: schedule,
      canManageDefaults: true,
      emailAvailable: false,
      emailUnavailableReason: 'Durable system mail is not configured.',
    }),
    replace: vi
      .fn<NoticePreferencesStore['replace']>()
      .mockResolvedValue({ revision: 1, changed: true, replayed: false }),
    replaceDefaults: vi
      .fn<NoticePreferencesStore['replaceDefaults']>()
      .mockResolvedValue({ revision: 1, changed: true, replayed: false }),
    readSubscription: vi
      .fn<NoticePreferencesStore['readSubscription']>()
      .mockResolvedValue({ revision: 0, followed: false, muted: false }),
    replaceSubscription: vi
      .fn<NoticePreferencesStore['replaceSubscription']>()
      .mockResolvedValue({ revision: 1, changed: true, replayed: false }),
    unsubscribe: vi
      .fn<NoticePreferencesStore['unsubscribe']>()
      .mockResolvedValue(true),
    close: () => Promise.resolve(),
  } satisfies NoticePreferencesStore;
}

export async function cleanAppsApiTestNotificationsModuleTestModuleTestTsFixture() {
  await Promise.all(openApplications.splice(0).map((app) => app.close()));
}

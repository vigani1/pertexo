import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import type { ApiScheduleRuntime } from '../../../src/platform/schedules/runtime.module.js';
import type { ApiNotificationRuntime } from '../../../src/platform/notifications/runtime.module.js';
import { WorkspaceInboxService } from '../../../src/notifications/service.js';

import { ScheduleManagementService } from '../../../src/schedules/service.js';
import { NOOP_SCHEDULE_TELEMETRY } from '../../../src/schedules/telemetry.js';
import { createApiScheduleRuntime } from '../../../src/platform/schedules/runtime.module.js';
import { createBetterAuthFixtureApplication } from '../../support/better-auth/fixture-application.js';
import { FixtureResourceOwner } from '../../browser/harness/resource-owner.js';

import {
  config,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerRegistersRequestedSchedulePreviewActualBetter(): void {
  it('registers requested schedule preview in the actual Better Auth fixture composition', async () => {
    const owner = new FixtureResourceOwner();
    const previewFireTimes = vi.fn().mockResolvedValue({
      observedAt: new Date('2026-08-25T12:00:00.000Z'),
      items: [new Date('2026-08-25T12:01:00.000Z')],
    });
    const scheduleDatabase = {
      list: vi.fn().mockResolvedValue([]),
      setEnabled: vi.fn().mockRejectedValue(new Error('unused')),
      listOccurrences: vi.fn().mockResolvedValue({ items: [] }),
      nextFireTimes: vi.fn().mockRejectedValue(new Error('unused')),
      previewFireTimes,
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const csrf = 'c'.repeat(32);
    const cookie = `pertexo_session=${'s'.repeat(43)}; pertexo_csrf=${csrf}`;
    const path =
      '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers/schedules/preview';
    let suppliedRuntime: ApiScheduleRuntime | undefined;
    try {
      applicationFixture.application = await createBetterAuthFixtureApplication(
        {
          config: config,
          dependencies: {
            ...dependencies(),
            identityRuntime: identityRuntime(undefined, true),
          },
          owner: owner,
          schedules: true,
          createSchedules: () => {
            suppliedRuntime = {
              service: new ScheduleManagementService(
                scheduleDatabase,
                NOOP_SCHEDULE_TELEMETRY,
              ),
              checkReadiness: async () => {
                await scheduleDatabase.checkReadiness();
              },
              close: vi.fn(async () => {
                await scheduleDatabase.close();
              }),
            };
            return Promise.resolve(suppliedRuntime);
          },
        },
      );
      const preview = await applicationFixture.application.inject({
        method: 'POST',
        url: path,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: {
          config: { kind: 'interval', intervalMinutes: 1 },
          count: 1,
        },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toEqual({
        observedAt: '2026-08-25T12:00:00.000Z',
        items: [{ scheduledAt: '2026-08-25T12:01:00.000Z' }],
      });
      expect(previewFireTimes).toHaveBeenCalledOnce();
      expect(scheduleDatabase.checkReadiness).toHaveBeenCalled();
      const noSession = await applicationFixture.application.inject({
        method: 'POST',
        url: path,
        payload: { config: { kind: 'interval', intervalMinutes: 1 } },
      });
      expect(noSession.statusCode).toBe(401);
      const noCsrf = await applicationFixture.application.inject({
        method: 'POST',
        url: path,
        headers: { cookie },
        payload: { config: { kind: 'interval', intervalMinutes: 1 } },
      });
      expect(noCsrf.statusCode).toBe(403);
      const invalid = await applicationFixture.application.inject({
        method: 'POST',
        url: path,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { config: { kind: 'interval', intervalMinutes: 0 } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(previewFireTimes).toHaveBeenCalledOnce();
      const denied = await applicationFixture.application.inject({
        method: 'POST',
        url: path.replace(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        ),
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { config: { kind: 'interval', intervalMinutes: 1 } },
      });
      expect(denied.statusCode).toBe(404);
      expect(previewFireTimes).toHaveBeenCalledOnce();
      previewFireTimes.mockRejectedValueOnce(
        new Error('private database failure'),
      );
      const unavailable = await applicationFixture.application.inject({
        method: 'POST',
        url: path,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { config: { kind: 'interval', intervalMinutes: 1 } },
      });
      expect(unavailable.statusCode).toBe(500);
    } finally {
      await owner.close();
      applicationFixture.application = undefined;
    }
    expect(scheduleDatabase.close).toHaveBeenCalledOnce();
    expect(suppliedRuntime?.close).toHaveBeenCalledOnce();
  });

  it('keeps schedule composition off for existing Better Auth fixtures by default', async () => {
    const owner = new FixtureResourceOwner();
    const createSchedules = vi.fn(createApiScheduleRuntime);
    try {
      applicationFixture.application = await createBetterAuthFixtureApplication(
        {
          config: config,
          dependencies: {
            ...dependencies(),
            identityRuntime: identityRuntime(undefined, true),
          },
          owner: owner,
          schedules: undefined,
          createSchedules: createSchedules,
        },
      );
      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers/schedules',
      });
      expect(response.statusCode).toBe(404);
      expect(createSchedules).not.toHaveBeenCalled();
    } finally {
      await owner.close();
      applicationFixture.application = undefined;
    }
  });

  it('retains fixture ownership when schedule readiness fails before application construction', async () => {
    const owner = new FixtureResourceOwner();
    const close = vi.fn().mockResolvedValue(undefined);
    const runtime: ApiScheduleRuntime = {
      service: {} as ScheduleManagementService,
      checkReadiness: () =>
        Promise.reject(new Error('schedule readiness unavailable')),
      close,
    };
    await expect(
      createBetterAuthFixtureApplication({
        config: config,
        dependencies: {
          ...dependencies(),
          identityRuntime: identityRuntime(undefined, true),
        },
        owner: owner,
        schedules: true,
        createSchedules: () => Promise.resolve(runtime),
      }),
    ).rejects.toThrow('schedule readiness unavailable');
    await owner.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('serves the workspace inbox through a supplied notification runtime and owns its readiness and close', async () => {
    const inboxDatabase = {
      listThreads: vi.fn(),
      readSummary: vi
        .fn()
        .mockResolvedValue({ unreadCount: 2, revision: '11' }),
      markThreadRead: vi.fn(),
      markAllRead: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const hints = {
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const notificationRuntime: ApiNotificationRuntime = {
      service: new WorkspaceInboxService(inboxDatabase),
      hints,
      checkReadiness: hints.checkReadiness,
      close: vi.fn().mockResolvedValue(undefined),
    };
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: identityRuntime(
        vi.fn().mockResolvedValue(undefined),
        true,
      ),
      notificationRuntime,
    });
    expect(hints.checkReadiness).toHaveBeenCalled();
    const summary =
      '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/notifications/summary';
    const cookie = `pertexo_session=${'s'.repeat(43)}`;
    expect(
      (
        await applicationFixture.application.inject({
          method: 'GET',
          url: summary,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await applicationFixture.application.inject({
          method: 'GET',
          url: summary.replace(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          ),
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    const read = await applicationFixture.application.inject({
      method: 'GET',
      url: summary,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ unreadCount: 2, revision: '11' });

    await applicationFixture.application.close();
    applicationFixture.application = undefined;
    expect(notificationRuntime.close).toHaveBeenCalledOnce();
  });
}

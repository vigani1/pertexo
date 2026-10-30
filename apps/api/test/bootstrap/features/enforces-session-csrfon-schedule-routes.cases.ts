import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import type { ApiScheduleRuntime } from '../../../src/platform/schedules/runtime.module.js';

import { ScheduleManagementService } from '../../../src/schedules/service.js';

import {
  config,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerEnforcesSessionCSRFOnScheduleRoutes(): void {
  it('enforces session and CSRF on schedule routes and owns readiness and close', async () => {
    const selectedIdentityRuntime = identityRuntime(
      vi.fn().mockResolvedValue(undefined),
      true,
    );
    const record = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      nodeId: 'schedule',
      kind: 'schedule' as const,
      status: 'active' as const,
      healthStatus: 'healthy' as const,
      lastErrorCode: null,
      reconciledAt: null,
      recurrence: { kind: 'interval' as const, intervalMinutes: 5 },
      misfirePolicy: 'catch_up_once' as const,
      nextFireAt: new Date('2026-08-25T12:05:00.000Z'),
      lastFireAt: null,
    };
    const scheduleDatabase = {
      list: vi.fn().mockResolvedValue([record]),
      setEnabled: vi
        .fn()
        .mockResolvedValue({ trigger: record, replayed: false }),
      listOccurrences: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            scheduledAt: '2026-08-25T12:00:00.000000Z',
            recordedAt: '2026-08-25T12:00:00.250000Z',
            outcome: 'skipped',
            runId: null,
          },
        ],
      }),
      nextFireTimes: vi.fn().mockResolvedValue({
        observedAt: new Date('2026-08-25T12:01:00.000Z'),
        items: [record.nextFireAt],
      }),
      previewFireTimes: vi.fn().mockResolvedValue({
        observedAt: new Date('2026-08-25T12:01:00.000Z'),
        items: [new Date('2026-08-25T12:16:00.000Z')],
      }),
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const scheduleRuntime = {
      service: new ScheduleManagementService(scheduleDatabase),
      checkReadiness: scheduleDatabase.checkReadiness,
      close: scheduleDatabase.close,
    } as ApiScheduleRuntime;
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      scheduleRuntime,
    });
    const base =
      '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers';
    const unauthenticated = await applicationFixture.application.inject({
      method: 'GET',
      url: `${base}/schedules`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const cookie = `pertexo_session=${'s'.repeat(43)}`;
    const hidden = await applicationFixture.application.inject({
      method: 'GET',
      url: `${base.replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')}/schedules`,
      headers: { cookie },
    });
    expect(hidden.statusCode).toBe(404);

    const listed = await applicationFixture.application.inject({
      method: 'GET',
      url: `${base}/schedules`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ kind: 'schedule' }] });

    const missingCsrf = await applicationFixture.application.inject({
      method: 'POST',
      url: `${base}/${record.id}/schedule/disable`,
      headers: { cookie, 'idempotency-key': 'disable' },
      payload: {},
    });
    expect(missingCsrf.statusCode).toBe(403);

    const csrf = 'c'.repeat(32);
    const missingKey = await applicationFixture.application.inject({
      method: 'POST',
      url: `${base}/${record.id}/schedule/disable`,
      headers: {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
      },
      payload: {},
    });
    expect(missingKey.statusCode).toBe(400);

    const disabled = await applicationFixture.application.inject({
      method: 'POST',
      url: `${base}/${record.id}/schedule/disable`,
      headers: {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
        'idempotency-key': 'disable',
      },
      payload: {},
    });
    expect(disabled.statusCode).toBe(200);
    expect(scheduleDatabase.setEnabled).toHaveBeenCalledOnce();
    expect(scheduleDatabase.checkReadiness).toHaveBeenCalled();

    const history = await applicationFixture.application.inject({
      method: 'GET',
      url: `${base}/${record.id}/schedule/occurrences?limit=5`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({
      items: [expect.objectContaining({ outcome: 'skipped', runId: null })],
      nextCursor: null,
    });
    const nextRuns = await applicationFixture.application.inject({
      method: 'GET',
      url: `${base}/${record.id}/schedule/next-runs`,
      headers: { cookie },
    });
    expect(nextRuns.json()).toEqual({
      observedAt: '2026-08-25T12:01:00.000Z',
      items: [{ scheduledAt: '2026-08-25T12:05:00.000Z' }],
    });
    expect(scheduleDatabase.nextFireTimes).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: record.id, count: 3 }),
    );
    const tooMany = await applicationFixture.application.inject({
      method: 'GET',
      url: `${base}/${record.id}/schedule/next-runs?count=11`,
      headers: { cookie },
    });
    expect(tooMany.statusCode).toBe(400);

    const preview = {
      config: { kind: 'interval', intervalMinutes: 15 },
      count: 1,
    };
    const unverifiedPreview = await applicationFixture.application.inject({
      method: 'POST',
      url: `${base}/schedules/preview`,
      headers: { cookie },
      payload: preview,
    });
    expect(unverifiedPreview.statusCode).toBe(403);
    const previewHeaders = {
      cookie: `${cookie}; pertexo_csrf=${csrf}`,
      'x-csrf-token': csrf,
    };
    const invalidPreview = await applicationFixture.application.inject({
      method: 'POST',
      url: `${base}/schedules/preview`,
      headers: previewHeaders,
      payload: { config: { kind: 'interval', intervalMinutes: 0 } },
    });
    expect(invalidPreview.statusCode).toBe(400);
    const previewed = await applicationFixture.application.inject({
      method: 'POST',
      url: `${base}/schedules/preview`,
      headers: previewHeaders,
      payload: preview,
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toEqual({
      observedAt: '2026-08-25T12:01:00.000Z',
      items: [{ scheduledAt: '2026-08-25T12:16:00.000Z' }],
    });
    expect(scheduleDatabase.previewFireTimes).toHaveBeenCalledOnce();

    await applicationFixture.application.close();
    applicationFixture.application = undefined;
    expect(scheduleDatabase.close).toHaveBeenCalledOnce();
  });
}

import {
  scheduleFireTimesResponseSchema,
  scheduleOccurrenceListResponseSchema,
} from '@pertexo/contracts/schedules';
import {
  ScheduleTriggerError,
  type ScheduleTriggerDatabase,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeScheduleOccurrenceCursor,
  encodeScheduleOccurrenceCursor,
} from '../../src/schedules/cursor.js';
import { ScheduleManagementService } from '../../src/schedules/service.js';
import type { ScheduleOperation } from '../../src/schedules/telemetry.js';

const read = {
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const accepted = {
  id: '11111111-1111-4111-8111-111111111111',
  scheduledAt: '2026-08-25T12:15:00.000000Z',
  recordedAt: '2026-08-25T12:15:00.412000Z',
  outcome: 'accepted' as const,
  runId: '22222222-2222-4222-8222-222222222222',
};
const skipped = {
  ...accepted,
  id: '33333333-3333-4333-8333-333333333333',
  scheduledAt: '2026-08-25T12:00:00.000000Z',
  recordedAt: '2026-08-25T12:03:10.000000Z',
  outcome: 'skipped' as const,
  runId: null,
};

function reads() {
  const unused = () =>
    Promise.reject(new Error('not exercised by schedule reads'));
  const database = {
    list: vi.fn<ScheduleTriggerDatabase['list']>(unused),
    setEnabled: vi.fn<ScheduleTriggerDatabase['setEnabled']>(unused),
    listOccurrences: vi
      .fn<ScheduleTriggerDatabase['listOccurrences']>()
      .mockResolvedValue({ items: [accepted, skipped] }),
    nextFireTimes: vi
      .fn<ScheduleTriggerDatabase['nextFireTimes']>()
      .mockResolvedValue({
        observedAt: new Date('2026-08-25T12:20:00.000Z'),
        items: [
          new Date('2026-08-25T12:30:00.000Z'),
          new Date('2026-08-25T12:45:00.000Z'),
        ],
      }),
    previewFireTimes: vi
      .fn<ScheduleTriggerDatabase['previewFireTimes']>()
      .mockResolvedValue({
        observedAt: new Date('2026-08-25T12:20:00.000Z'),
        items: [new Date('2026-08-26T07:00:00.000Z')],
      }),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies ScheduleTriggerDatabase;
  const operations: ScheduleOperation[] = [];
  const service = new ScheduleManagementService(database, {
    measure: (operation, work) => {
      operations.push(operation);
      return work();
    },
  });
  return { database, operations, service };
}

describe('schedule fire history and next runs', () => {
  it('pages occurrence metadata newest first with a trigger-bound cursor', async () => {
    const { database, operations, service } = reads();
    database.listOccurrences.mockResolvedValueOnce({
      items: [accepted],
      nextCursor: { scheduledAt: accepted.scheduledAt, id: accepted.id },
    });

    const first = await service.listOccurrences({ ...read, limit: 1 });
    expect(scheduleOccurrenceListResponseSchema.parse(first)).toEqual(first);
    expect(first.items).toEqual([accepted]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain(accepted.id);

    const second = await service.listOccurrences({
      ...read,
      after: first.nextCursor ?? '',
    });
    expect(second).toEqual({ items: [accepted, skipped], nextCursor: null });
    expect(database.listOccurrences.mock.calls).toEqual([
      [{ ...read, limit: 1 }],
      [
        {
          ...read,
          after: { scheduledAt: accepted.scheduledAt, id: accepted.id },
        },
      ],
    ]);
    expect(operations).toEqual([
      'schedule.occurrences',
      'schedule.occurrences',
    ]);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    [
      'another trigger’s',
      encodeScheduleOccurrenceCursor('44444444-4444-4444-8444-444444444444', {
        scheduledAt: accepted.scheduledAt,
        id: accepted.id,
      }),
    ],
    [
      'tampered',
      Buffer.from(
        JSON.stringify({
          kind: 'webhook_deliveries',
          triggerId: read.triggerId,
          scheduledAt: accepted.scheduledAt,
          id: accepted.id,
        }),
      ).toString('base64url'),
    ],
  ])('rejects a %s cursor before reading', async (_label, after) => {
    const { database, service } = reads();
    await expect(
      service.listOccurrences({ ...read, after }),
    ).rejects.toMatchObject({
      code: 'request.invalid',
      safeDetail: 'The occurrence cursor is invalid.',
    });
    expect(database.listOccurrences).not.toHaveBeenCalled();
  });

  it('round-trips the exact microsecond position', () => {
    const position = { scheduledAt: accepted.scheduledAt, id: accepted.id };
    expect(
      decodeScheduleOccurrenceCursor(
        encodeScheduleOccurrenceCursor(read.triggerId, position),
        read.triggerId,
      ),
    ).toEqual(position);
  });

  it('projects fire times as ISO instants with the database observation', async () => {
    const { database, operations, service } = reads();

    const next = await service.nextRuns({ ...read, count: 2 });

    expect(scheduleFireTimesResponseSchema.parse(next)).toEqual(next);
    expect(next).toEqual({
      observedAt: '2026-08-25T12:20:00.000Z',
      items: [
        { scheduledAt: '2026-08-25T12:30:00.000Z' },
        { scheduledAt: '2026-08-25T12:45:00.000Z' },
      ],
    });
    expect(database.nextFireTimes).toHaveBeenCalledExactlyOnceWith({
      ...read,
      count: 2,
    });
    expect(operations).toEqual(['schedule.next_runs']);
  });

  it('previews only the rule, never the misfire policy', async () => {
    const { database, operations, service } = reads();
    const scope = {
      workspaceId: read.workspaceId,
      actorId: read.actorId,
      workflowId: read.workflowId,
    };

    await service.previewRuns({
      ...scope,
      config: {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'Europe/Paris',
        misfirePolicy: 'skip',
      },
      count: 3,
    });
    await service.previewRuns({
      ...scope,
      config: {
        kind: 'interval',
        intervalMinutes: 15,
        misfirePolicy: 'catch_up_once',
      },
      count: 1,
    });

    expect(database.previewFireTimes.mock.calls).toEqual([
      [
        {
          ...scope,
          recurrence: {
            kind: 'cron',
            expression: '0 9 * * 1-5',
            timezone: 'Europe/Paris',
          },
          count: 3,
        },
      ],
      [
        {
          ...scope,
          recurrence: { kind: 'interval', intervalMinutes: 15 },
          count: 1,
        },
      ],
    ]);
    expect(operations).toEqual(['schedule.preview', 'schedule.preview']);
  });

  it('maps hidden triggers and unschedulable rules to stable problems', async () => {
    const { database, service } = reads();
    database.listOccurrences.mockRejectedValueOnce(
      new ScheduleTriggerError('not_found'),
    );
    database.nextFireTimes.mockRejectedValueOnce(
      new ScheduleTriggerError('not_found'),
    );
    database.previewFireTimes.mockRejectedValueOnce(
      new ScheduleTriggerError('invalid_recurrence'),
    );

    await expect(service.listOccurrences(read)).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    await expect(service.nextRuns({ ...read, count: 3 })).rejects.toMatchObject(
      { code: 'resource.not_found' },
    );
    await expect(
      service.previewRuns({
        ...read,
        config: {
          kind: 'cron',
          expression: '0 25 * * *',
          timezone: 'Europe/Paris',
        },
        count: 3,
      }),
    ).rejects.toMatchObject({
      code: 'request.invalid',
      safeDetail: expect.stringContaining('cannot be scheduled') as unknown,
    });
  });

  it('preserves unknown read failures by identity', async () => {
    const { database, service } = reads();
    const failure = new Error('database unavailable');
    database.nextFireTimes.mockRejectedValueOnce(failure);
    await expect(service.nextRuns({ ...read, count: 3 })).rejects.toBe(failure);
  });
});

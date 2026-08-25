import { describe, expect, it } from 'vitest';

import {
  scheduleManagementCommandResponseSchema,
  scheduleTriggerListResponseSchema,
} from '../src/http/schedules.js';

const trigger = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  nodeId: 'daily-report',
  kind: 'schedule',
  status: 'active',
  healthStatus: 'healthy',
  lastErrorCode: null,
  reconciledAt: '2026-08-25T10:00:00.000Z',
  recurrence: {
    kind: 'cron',
    expression: '0 9 * * 1-5',
    timezone: 'Europe/Paris',
  },
  misfirePolicy: 'catch_up_once',
  nextFireAt: '2026-08-26T07:00:00.000Z',
  lastFireAt: null,
};

describe('schedule public contracts', () => {
  it('accepts only bounded recurrence summaries', () => {
    expect(
      scheduleTriggerListResponseSchema.parse({ items: [trigger] }),
    ).toEqual({
      items: [trigger],
    });
    expect(() =>
      scheduleTriggerListResponseSchema.parse({
        items: [{ ...trigger, leaseOwner: 'internal' }],
      }),
    ).toThrow();
    expect(() =>
      scheduleTriggerListResponseSchema.parse({
        items: [
          {
            ...trigger,
            recurrence: { ...trigger.recurrence, fingerprint: 'internal' },
          },
        ],
      }),
    ).toThrow();
  });

  it('keeps enable and disable responses strict', () => {
    expect(
      scheduleManagementCommandResponseSchema.parse({
        trigger,
        replayed: true,
      }),
    ).toEqual({ trigger, replayed: true });
    expect(() =>
      scheduleManagementCommandResponseSchema.parse({
        trigger,
        replayed: false,
        leaseToken: 'internal',
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import {
  scheduleFireTimesResponseSchema,
  scheduleManagementCommandResponseSchema,
  scheduleNextRunsQuerySchema,
  scheduleOccurrenceListQuerySchema,
  scheduleOccurrenceListResponseSchema,
  schedulePreviewRequestSchema,
  scheduleTriggerListResponseSchema,
} from '../src/http/schedules.js';
import {
  schedulesClientContract,
  schedulesOpenApiDocument,
} from '../src/schedules.js';

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

type OpenApiOperation = Readonly<{
  parameters?: readonly Readonly<Record<string, unknown>>[];
  responses: Readonly<Record<string, unknown>>;
  security?: readonly Readonly<Record<string, readonly unknown[]>>[];
}>;

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

  it('pages occurrence metadata with explicit outcomes and bounded queries', () => {
    const occurrence = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      scheduledAt: '2026-08-26T07:00:00.000000Z',
      recordedAt: '2026-08-26T07:00:01.250000Z',
      outcome: 'accepted',
      runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    const page = { items: [occurrence], nextCursor: 'opaque' };
    expect(scheduleOccurrenceListResponseSchema.parse(page)).toEqual(page);
    for (const invalid of [
      { ...page, items: [{ ...occurrence, outcome: 'deferred' }] },
      { ...page, items: [{ ...occurrence, leaseToken: 'internal' }] },
      { ...page, nextCursor: '' },
    ])
      expect(() =>
        scheduleOccurrenceListResponseSchema.parse(invalid),
      ).toThrow();
    expect(
      scheduleOccurrenceListQuerySchema.parse({ limit: '10', after: 'x' }),
    ).toEqual({ limit: 10, after: 'x' });
    for (const query of [{ limit: '0' }, { limit: '101' }, { order: 'asc' }])
      expect(() => scheduleOccurrenceListQuerySchema.parse(query)).toThrow();
  });

  it('bounds fire-time reads to ten instants', () => {
    expect(scheduleNextRunsQuerySchema.parse({ count: '10' })).toEqual({
      count: 10,
    });
    for (const query of [{ count: '0' }, { count: '11' }, { from: 'now' }])
      expect(() => scheduleNextRunsQuerySchema.parse(query)).toThrow();
    const times = {
      observedAt: '2026-08-26T06:59:00.000Z',
      items: [{ scheduledAt: '2026-08-26T07:00:00.000Z' }],
    };
    expect(scheduleFireTimesResponseSchema.parse(times)).toEqual(times);
    expect(() =>
      scheduleFireTimesResponseSchema.parse({
        ...times,
        items: Array.from({ length: 11 }, () => times.items[0]),
      }),
    ).toThrow();
  });

  it('accepts only the Schedule step’s own setup shape for a preview', () => {
    for (const config of [
      { kind: 'cron', expression: '0 9 * * MON-FRI', timezone: 'Europe/Paris' },
      {
        kind: 'interval',
        intervalMinutes: 43_200,
        misfirePolicy: 'skip',
      },
    ])
      expect(schedulePreviewRequestSchema.parse({ config })).toEqual({
        config,
      });
    for (const request of [
      { config: { kind: 'cron', expression: '0 9 * * *', timezone: '' } },
      {
        config: {
          kind: 'cron',
          expression: '0 9 * * *  ',
          timezone: 'Europe/Paris',
        },
      },
      {
        config: {
          kind: 'cron',
          expression: '0 9 ? * 1',
          timezone: 'Europe/Paris',
        },
      },
      {
        config: {
          kind: 'cron',
          expression: '0 0 9 * * 1',
          timezone: 'Europe/Paris',
        },
      },
      { config: { kind: 'interval', intervalMinutes: 0 } },
      { config: { kind: 'interval', intervalMinutes: 1.5 } },
      { config: { kind: 'interval', intervalMinutes: 5, anchorAt: 'now' } },
      { config: { kind: 'interval', intervalMinutes: 5 }, count: 11 },
      { config: { kind: 'interval', intervalMinutes: 5 }, count: '3' },
    ])
      expect(() => schedulePreviewRequestSchema.parse(request)).toThrow();
  });

  it('documents session security, command headers, and typed responses', () => {
    expect(
      schedulesOpenApiDocument.components.securitySchemes.cookieSession,
    ).toBeDefined();
    for (const route of schedulesClientContract.routes) {
      const path = route.path.replaceAll(/:([A-Za-z]+)/gu, '{$1}');
      const paths = schedulesOpenApiDocument.paths as unknown as Readonly<
        Record<string, Readonly<Record<string, OpenApiOperation>>>
      >;
      const operation = paths[path]?.[route.method.toLowerCase()];
      expect(operation?.security).toEqual([{ cookieSession: [] }]);
      expect(operation?.responses['200']).toHaveProperty(
        'content.application/json.schema.$ref',
      );
      expect(operation?.responses).toHaveProperty('403');
      for (const header of 'requiredHeaders' in route
        ? route.requiredHeaders
        : [])
        expect(operation?.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              in: 'header',
              name: header,
              required: true,
            }),
          ]),
        );
    }
  });
});

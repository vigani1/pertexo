import { describe, expect, it } from 'vitest';

import {
  scheduleFireTimesResponseSchema,
  scheduleWindowFireTimesResponseSchema,
  scheduleManagementCommandResponseSchema,
  scheduleNextRunsQuerySchema,
  scheduleOccurrenceListQuerySchema,
  scheduleOccurrenceListResponseSchema,
  schedulePreviewRequestSchema,
  scheduleStepConfigSchema,
  scheduleTriggerListResponseSchema,
} from '../../src/schemas/triggers/schedules.js';
import { schedulesOpenApiDocument } from '../../src/server.js';
import {
  CRON_EXPRESSION_LIMITS,
  TIME_ZONE_NAME_CHARACTERS,
} from '@pertexo/workflow-model';

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
    expect(
      scheduleTriggerListResponseSchema.parse({
        items: [{ ...trigger, leaseOwner: 'internal' }],
      }),
    ).toEqual({ items: [trigger] });
    expect(
      scheduleTriggerListResponseSchema.parse({
        items: [
          {
            ...trigger,
            recurrence: { ...trigger.recurrence, fingerprint: 'internal' },
          },
        ],
      }),
    ).toEqual({ items: [trigger] });
  });

  it('keeps enable and disable responses strict', () => {
    expect(
      scheduleManagementCommandResponseSchema.parse({
        trigger,
        replayed: true,
      }),
    ).toEqual({ trigger, replayed: true });
    expect(
      scheduleManagementCommandResponseSchema.parse({
        trigger,
        replayed: false,
        leaseToken: 'internal',
      }),
    ).toEqual({ trigger, replayed: false });
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
      { ...page, nextCursor: '' },
    ])
      expect(() =>
        scheduleOccurrenceListResponseSchema.parse(invalid),
      ).toThrow();
    expect(
      scheduleOccurrenceListResponseSchema.parse({
        ...page,
        items: [{ ...occurrence, leaseToken: 'internal' }],
      }),
    ).toEqual(page);
    expect(
      scheduleOccurrenceListQuerySchema.parse({ limit: '10', after: 'x' }),
    ).toEqual({ limit: 10, after: 'x' });
    for (const query of [{ limit: '0' }, { limit: '101' }, { order: 'asc' }])
      expect(() => scheduleOccurrenceListQuerySchema.parse(query)).toThrow();
  });

  it('accepts a day window and its minute-resolution fire times', () => {
    expect(scheduleNextRunsQuerySchema.parse({ window: 'day' })).toEqual({
      window: 'day',
    });
    expect(() =>
      scheduleNextRunsQuerySchema.parse({ window: 'week' }),
    ).toThrow();
    const times = {
      observedAt: '2026-08-26T00:00:00.000Z',
      items: Array.from({ length: 1441 }, () => ({
        scheduledAt: '2026-08-26T01:00:00.000Z',
      })),
    };
    expect(scheduleWindowFireTimesResponseSchema.parse(times)).toEqual(times);
    expect(() =>
      scheduleWindowFireTimesResponseSchema.parse({
        ...times,
        items: [...times.items, ...times.items.slice(0, 1)],
      }),
    ).toThrow();
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
    const paths = schedulesOpenApiDocument.paths as unknown as Readonly<
      Record<string, Readonly<Record<string, OpenApiOperation>>>
    >;
    for (const methods of Object.values(paths))
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.security).toEqual([
          { cookieSession: [] },
          { apiToken: [] },
        ]);
        expect(operation.responses['200']).toHaveProperty(
          'content.application/json.schema.$ref',
        );
        expect(operation.responses).toHaveProperty('403');
        if (method !== 'get')
          // Header names don't depend on case.
          expect(
            operation.parameters?.some(
              (parameter) =>
                parameter.in === 'header' &&
                String(parameter.name).toLowerCase() === 'x-csrf-token' &&
                parameter.required === false,
            ),
          ).toBe(true);
      }
  });

  it('holds a Schedule step to the cron expression and time zone limits the step itself enforces', () => {
    // Five fields: one long minute list, then `* * * *`.
    const expressionOf = (characters: number) => {
      const minutes = '1,'.repeat((characters - 9) / 2) + '1';
      return `${minutes} * * * *`;
    };
    const config = (expression: string, timezone: string) => ({
      kind: 'cron' as const,
      expression,
      timezone,
    });
    const longest = expressionOf(CRON_EXPRESSION_LIMITS.maximumCharacters);
    expect(longest).toHaveLength(CRON_EXPRESSION_LIMITS.maximumCharacters);
    expect(
      scheduleStepConfigSchema.safeParse(config(longest, 'UTC')).success,
    ).toBe(true);
    expect(
      scheduleStepConfigSchema.safeParse(config(`1,${longest}`, 'UTC')).success,
    ).toBe(false);
    const zone = 'A'.repeat(TIME_ZONE_NAME_CHARACTERS);
    expect(
      scheduleStepConfigSchema.safeParse(config('* * * * *', zone)).success,
    ).toBe(true);
    expect(
      scheduleStepConfigSchema.safeParse(config('* * * * *', `${zone}A`))
        .success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  scheduleManagementCommandResponseSchema,
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

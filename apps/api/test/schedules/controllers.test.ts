import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ScheduleModule } from '../../src/schedules/module.js';
import type { ScheduleManagementService } from '../../src/schedules/schedule-management.service.js';
import { FakeIdentityModule } from '../support/identity-module.js';
import {
  HARNESS_ACTOR_ID as actorId,
  ownerAccess,
  routeHarness,
} from '../support/route-harness.js';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const triggerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const triggers = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`;
const schedule = `${triggers}/${triggerId}/schedule`;
const route = { workspaceId, workflowId, triggerId };
const config = {
  kind: 'cron',
  expression: '0 9 * * 1-5',
  timezone: 'Europe/Paris',
  misfirePolicy: 'skip',
};
const fireTimes = { observedAt: '2026-08-25T12:00:00.000Z', items: [] };
const trigger = {
  id: triggerId,
  workflowId,
  workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  nodeId: 'schedule',
  kind: 'schedule',
  status: 'active',
  healthStatus: 'healthy',
  lastErrorCode: null,
  reconciledAt: null,
  recurrence: { kind: 'interval', intervalMinutes: 5 },
  misfirePolicy: 'skip',
  nextFireAt: '2026-08-25T12:05:00.000Z',
  lastFireAt: null,
};

const service = {
  list: vi.fn(),
  listOccurrences: vi.fn(),
  nextRuns: vi.fn(),
  previewRuns: vi.fn(),
  setEnabled: vi.fn(),
};
let harness: Awaited<ReturnType<typeof routeHarness>>;

beforeAll(async () => {
  harness = await routeHarness(
    ScheduleModule.register(
      service as unknown as ScheduleManagementService,
      ownerAccess,
      { module: FakeIdentityModule },
    ),
  );
});
afterAll(() => harness.close());
beforeEach(() => {
  vi.clearAllMocks();
  service.list.mockResolvedValue({ items: [] });
  service.listOccurrences.mockResolvedValue({ items: [], nextCursor: null });
  service.nextRuns.mockResolvedValue(fireTimes);
  service.previewRuns.mockResolvedValue(fireTimes);
});

describe('schedule management routes', () => {
  it('lists with the route identifiers and the signed-in actor', async () => {
    const reply = await harness.send('GET', `${triggers}/schedules`);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(service.list).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
    });
  });

  it('pages occurrences only when the client asked to', async () => {
    await harness.send('GET', `${schedule}/occurrences`);
    await harness.send('GET', `${schedule}/occurrences`, {
      query: { limit: '5', after: 'opaque-cursor' },
    });
    expect(service.listOccurrences.mock.calls).toEqual([
      [{ ...route, actorId }],
      [{ ...route, actorId, limit: 5, after: 'opaque-cursor' }],
    ]);
  });

  it.each([{ limit: '0' }, { limit: '101' }, { after: '' }, { sort: 'asc' }])(
    'refuses occurrence query %j before reading',
    async (query) => {
      const reply = await harness.send('GET', `${schedule}/occurrences`, {
        query,
      });
      expect(reply.statusCode).toBe(400);
      expect(service.listOccurrences).not.toHaveBeenCalled();
    },
  );

  it('defaults next runs to three and bounds the count', async () => {
    await harness.send('GET', `${schedule}/next-runs`);
    await harness.send('GET', `${schedule}/next-runs`, {
      query: { count: '10' },
    });
    expect(service.nextRuns.mock.calls).toEqual([
      [{ ...route, actorId, count: 3 }],
      [{ ...route, actorId, count: 10 }],
    ]);
    for (const query of [{ count: '0' }, { count: '11' }, { at: 'now' }])
      expect(
        (await harness.send('GET', `${schedule}/next-runs`, { query }))
          .statusCode,
      ).toBe(400);
    expect(service.nextRuns).toHaveBeenCalledTimes(2);
  });

  it('previews only a strictly valid Schedule step setup', async () => {
    const preview = (body: unknown) =>
      harness.send('POST', `${triggers}/schedules/preview`, { body });
    expect((await preview({ config })).statusCode).toBe(200);
    expect((await preview({ config, count: 1 })).statusCode).toBe(200);
    expect(service.previewRuns.mock.calls).toEqual([
      [{ workspaceId, workflowId, actorId, config, count: 3 }],
      [{ workspaceId, workflowId, actorId, config, count: 1 }],
    ]);
    for (const body of [
      {},
      { config: { ...config, anchorAt: 'now' } },
      { config: { kind: 'interval', intervalMinutes: 0 } },
      { config, count: 11 },
      { config, triggerId },
    ])
      expect((await preview(body)).statusCode, JSON.stringify(body)).toBe(400);
    expect(service.previewRuns).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['enable', true],
    ['disable', false],
  ] as const)('forwards %s once', async (command, enabled) => {
    service.setEnabled.mockResolvedValue({ trigger, replayed: false });
    const reply = await harness.send('POST', `${schedule}/${command}`, {
      body: {},
      headers: { 'idempotency-key': 'schedule-command' },
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(service.setEnabled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...route,
        actorId,
        idempotencyKey: 'schedule-command',
      }),
      { enabled },
    );
  });

  it.each([undefined, 'first,second'])(
    'refuses a missing or malformed idempotency key %j before changing anything',
    async (key) => {
      const reply = await harness.send('POST', `${schedule}/enable`, {
        body: {},
        headers: key === undefined ? {} : { 'idempotency-key': key },
      });
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toMatchObject({ code: 'request.invalid' });
      expect(service.setEnabled).not.toHaveBeenCalled();
    },
  );

  it.each([null, { unexpected: true }])(
    'requires the exact empty command body %#',
    async (body) => {
      const reply = await harness.send('POST', `${schedule}/enable`, {
        body,
        headers: { 'idempotency-key': 'schedule-command' },
      });
      expect(reply.statusCode).toBe(400);
      expect(service.setEnabled).not.toHaveBeenCalled();
    },
  );
});

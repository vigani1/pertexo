import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { WorkflowRunsController } from '../../../src/workflow-runs/http/controllers.js';
import { WorkflowRunsModule } from '../../../src/workflow-runs/module.js';
import { GetWorkflowRunStatisticsUseCase } from '../../../src/workflow-runs/statistics.js';
import {
  CancelWorkflowRunUseCase,
  GetWorkflowRunUseCase,
  ListWorkflowRunsUseCase,
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  StreamRunEventsUseCase,
} from '../../../src/workflow-runs/workflow-runs.service.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import { ownerAccess, routeHarness } from '../../support/route-harness.js';
import { runId, workflowId, workspaceId } from './controllers/fixture.js';

const list = { execute: vi.fn() };
const statistics = { execute: vi.fn() };
const start = { execute: vi.fn() };
const stream = { execute: vi.fn() };
const unused = { execute: vi.fn() };
const workspace = `/v1/workspaces/${workspaceId}`;
let harness: Awaited<ReturnType<typeof routeHarness>>;

/** Real routing, guards and parsing in front of use cases this test controls. */
beforeAll(async () => {
  harness = await routeHarness({
    module: WorkflowRunsModule,
    imports: [{ module: FakeIdentityModule }],
    controllers: [WorkflowRunsController],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
      { provide: StartWorkflowRunUseCase, useValue: start },
      { provide: ReplayWorkflowRunUseCase, useValue: unused },
      { provide: GetWorkflowRunUseCase, useValue: unused },
      { provide: ListWorkflowRunsUseCase, useValue: list },
      { provide: GetWorkflowRunStatisticsUseCase, useValue: statistics },
      { provide: StreamRunEventsUseCase, useValue: stream },
      { provide: CancelWorkflowRunUseCase, useValue: unused },
    ],
  });
});
afterAll(() => harness.close());
beforeEach(() => {
  vi.clearAllMocks();
  list.execute.mockResolvedValue({ items: [], nextCursor: null });
});

describe('workflow run routes', () => {
  it('forwards bounded run-history filters as typed values', async () => {
    const reply = await harness.send('GET', `${workspace}/runs`, {
      query: {
        limit: '25',
        workflowId,
        status: 'succeeded',
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      },
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(list.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        limit: 25,
        workflowId,
        status: 'succeeded',
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      }),
    );
  });

  it.each([{ unknown: 'true' }, { runValueKey: 'customer' }])(
    'refuses run-history query %j before reading',
    async (query) => {
      const reply = await harness.send('GET', `${workspace}/runs`, { query });
      expect(reply.statusCode).toBe(400);
      expect(list.execute).not.toHaveBeenCalled();
    },
  );

  it.each([{ window: '30d' }, { createdAtFrom: '2026-08-20T00:00:00.000Z' }])(
    'refuses statistics query %j before reading',
    async (query) => {
      const reply = await harness.send('GET', `${workspace}/run-statistics`, {
        query,
      });
      expect(reply.statusCode).toBe(400);
      expect(statistics.execute).not.toHaveBeenCalled();
    },
  );

  it('refuses a workspace that is not an identifier', async () => {
    const reply = await harness.send(
      'GET',
      '/v1/workspaces/not-a-workspace/run-statistics',
    );
    expect(reply.statusCode).toBe(400);
    expect(statistics.execute).not.toHaveBeenCalled();
  });

  it('refuses to start a run without an idempotency key', async () => {
    const reply = await harness.send(
      'POST',
      `${workspace}/workflows/${workflowId}/runs`,
      { body: {} },
    );
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toMatchObject({ code: 'request.invalid' });
    expect(start.execute).not.toHaveBeenCalled();
  });

  it.each(['-1', 'abc', '1'.repeat(16)])(
    'refuses Last-Event-ID %j before opening the stream',
    async (lastEventId) => {
      const reply = await harness.send(
        'GET',
        `${workspace}/runs/${runId}/events`,
        {
          headers: { 'last-event-id': lastEventId },
        },
      );
      expect(reply.statusCode).toBe(400);
      expect(stream.execute).not.toHaveBeenCalled();
    },
  );
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkflowRunsController } from '../../../src/workflow-runs/http/workflow-runs.controller.js';
import type { WorkflowRunPersistence } from '../../../src/workflow-runs/ports.js';
import { GetWorkflowRunStatisticsService } from '../../../src/workflow-runs/statistics.js';
import { GetUsageCapacityService } from '../../../src/workflow-runs/usage/capacity.js';
import { UsageCapacityController } from '../../../src/workflow-runs/usage/usage-capacity.controller.js';
import {
  CancelWorkflowRunService,
  GetWorkflowRunService,
  ListWorkflowRunsService,
  ReplayWorkflowRunService,
  StartWorkflowRunService,
  StreamRunEventsService,
} from '../../../src/workflow-runs/workflow-runs.service.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import { ownerAccess, routeHarness } from '../../support/route-harness.js';
import { usageCapacitySnapshot } from '../usage/capacity.fixture.js';
import { workspaceId } from './controllers.fixture.js';

const byStatus = {
  queued: 0,
  running: 1,
  waiting: 0,
  succeeded: 6,
  failed: 2,
  canceled: 0,
  timed_out: 1,
  outcome_unknown: 0,
};
const statisticsSnapshot = {
  asOf: '2026-09-25T12:00:00.123456Z',
  current: { queued: 0, running: 1, waiting: 2 },
  window: {
    duration: '24h',
    createdAtFrom: '2026-09-24T12:00:00.123456Z',
    createdAtBefore: '2026-09-25T12:00:00.123456Z',
    total: 10,
    byStatus,
  },
} as const;
const persistence = {
  statistics: vi.fn<WorkflowRunPersistence['statistics']>(),
  usageCapacity: vi.fn<WorkflowRunPersistence['usageCapacity']>(),
};
const unused = { execute: vi.fn() };
const workspace = `/v1/workspaces/${workspaceId}`;
// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class RunAnswersUnderTest {}
let harness: Awaited<ReturnType<typeof routeHarness>>;

/** Real routes and real services, over persistence this test controls. */
beforeAll(async () => {
  harness = await routeHarness({
    module: RunAnswersUnderTest,
    imports: [{ module: FakeIdentityModule }],
    controllers: [WorkflowRunsController, UsageCapacityController],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
      {
        provide: GetWorkflowRunStatisticsService,
        useValue: new GetWorkflowRunStatisticsService(persistence, ownerAccess),
      },
      {
        provide: GetUsageCapacityService,
        useValue: new GetUsageCapacityService(persistence, ownerAccess),
      },
      ...[
        StartWorkflowRunService,
        ReplayWorkflowRunService,
        GetWorkflowRunService,
        ListWorkflowRunsService,
        StreamRunEventsService,
        CancelWorkflowRunService,
      ].map((service) => ({ provide: service, useValue: unused })),
    ],
  });
});
afterAll(() => harness.close());

describe('run statistics and usage answers over HTTP', () => {
  it('answers statistics that keep the public contract', async () => {
    persistence.statistics.mockResolvedValueOnce(statisticsSnapshot);
    const reply = await harness.send('GET', `${workspace}/run-statistics`);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ window: { byStatus } });
  });

  it('fails with a server error rather than answer statistics that break the public contract', async () => {
    persistence.statistics.mockResolvedValueOnce({
      ...statisticsSnapshot,
      window: {
        ...statisticsSnapshot.window,
        byStatus: { ...byStatus, failed: -1 },
      },
    });
    const reply = await harness.send('GET', `${workspace}/run-statistics`);
    expect(reply.statusCode).toBe(500);
  });

  it('answers capacity that keeps the public contract', async () => {
    persistence.usageCapacity.mockResolvedValueOnce(usageCapacitySnapshot());
    const reply = await harness.send('GET', `${workspace}/usage-capacity`);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(usageCapacitySnapshot());
  });

  it('fails with a server error rather than answer an invalid capacity snapshot', async () => {
    persistence.usageCapacity.mockResolvedValueOnce({
      ...usageCapacitySnapshot(),
      artifacts: { ...usageCapacitySnapshot().artifacts, chargedBytes: '-1' },
    });
    const reply = await harness.send('GET', `${workspace}/usage-capacity`);
    expect(reply.statusCode).toBe(500);
  });
});

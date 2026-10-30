import {
  InvalidQueueDeliveryError,
  QUEUE_FOR_JOB,
  QUEUE_NAME,
  type JobName,
  type QueueDelivery,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  maintenanceDeliveryHandler,
  type MaintenanceHandlers,
} from '../../src/maintenance/delivery-handler.js';

const context = { signal: new AbortController().signal };

function delivery(name: JobName): QueueDelivery {
  return {
    name,
    data: {},
    transport: { attemptsMade: 0, jobId: 'outbox-test' },
  } as unknown as QueueDelivery;
}

function everyHandler() {
  const handle = () => vi.fn().mockResolvedValue(undefined);
  const handlers = {
    failureNotification: { handle: handle() },
    errorWorkflow: { handle: handle() },
    reconciliation: { handle: handle() },
    replay: { handle: handle() },
    unknownOutcome: { handle: handle() },
    workspaceInvitation: { handle: handle() },
    connectionHealth: { handle: handle() },
  };
  return {
    handlers: handlers as unknown as MaintenanceHandlers,
    calls: () =>
      Object.values(handlers).reduce(
        (total, { handle: spy }) => total + spy.mock.calls.length,
        0,
      ),
  };
}

const jobs = Object.entries(QUEUE_FOR_JOB) as [JobName, string][];
const maintenanceJobs = jobs
  .filter(([, queue]) => queue === QUEUE_NAME.maintenance)
  .map(([name]) => name);
const otherJobs = jobs
  .filter(([, queue]) => queue !== QUEUE_NAME.maintenance)
  .map(([name]) => name);

// worker-03: a job routed to the maintenance queue that the handler forgets
// fails as unrecoverable and is never retried, so every one must be handled.
describe('maintenance delivery', () => {
  it('has maintenance jobs to check', () => {
    expect(maintenanceJobs.length).toBeGreaterThan(0);
  });

  it.each(maintenanceJobs)(
    'hands %s to exactly one maintenance handler',
    async (name) => {
      const { handlers, calls } = everyHandler();
      await expect(
        maintenanceDeliveryHandler(handlers)(delivery(name), context),
      ).resolves.toBeUndefined();
      expect(calls()).toBe(1);
    },
  );

  it.each(otherJobs)('refuses %s, which another queue owns', async (name) => {
    const { handlers, calls } = everyHandler();
    await expect(
      maintenanceDeliveryHandler(handlers)(delivery(name), context),
    ).rejects.toBeInstanceOf(InvalidQueueDeliveryError);
    expect(calls()).toBe(0);
  });
});

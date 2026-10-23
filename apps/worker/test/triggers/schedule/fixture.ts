import type { Queue } from 'bullmq';
import { describe } from 'vitest';

import type { BenchmarkScanGate } from '../../support/infrastructure/benchmark-scan-gate.js';
import { createScheduleTriggerFixture } from '../../support/schedule-trigger-fixture.js';

export function recordBenchmarkOperation(startedAt: number): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION=${JSON.stringify({ name: 'schedule-to-run-start', startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: 'release verified due schedule to scanner through durable run.started observation (25ms polling)' })}\n`,
  );
}

const enabled = process.env.WORKER_TRIGGER_INTEGRATION === 'true';

export const describeIntegration = enabled ? describe : describe.skip;

const fixture = createScheduleTriggerFixture();

export const {
  actorId,
  apiConfig,
  apiQuery,
  authoringOptions,
  dispatcherConfig,
  ownerQuery,
  ownerQueryIn,
  redisUrl,
  workerConfig,
  workerQuery,
  workspaceId,
} = fixture;

export let queue: Queue;

export const resources: { close(): Promise<void> }[] = [];

export const benchmark: { benchmarkScanGate: BenchmarkScanGate | undefined } = {
  benchmarkScanGate: undefined,
};

export function registerResource<Resource extends { close(): Promise<void> }>(
  resource: Resource,
): Resource {
  resources.push(resource);
  return resource;
}

export function transferResource(resource: { close(): Promise<void> }): void {
  const index = resources.indexOf(resource);
  if (index === -1)
    throw new Error('Schedule fixture resource ownership is missing');
  resources.splice(index, 1);
}

export async function prepareDirectScheduleWorkerIntegrationGateFixture() {
  await fixture.setup();
  queue = fixture.queue;
}

export async function closeDirectScheduleWorkerIntegrationGateFixture() {
  benchmark.benchmarkScanGate?.release();
  const cleanupErrors: unknown[] = [];
  const attempt = async (
    label: string,
    operation: () => void | Promise<void>,
  ): Promise<void> => {
    await Promise.resolve()
      .then(operation)
      .catch((cause: unknown) => {
        cleanupErrors.push(
          new Error(`Schedule integration cleanup failed: ${label}`, {
            cause,
          }),
        );
      });
  };
  for (const resource of resources.splice(0).reverse())
    await attempt('runtime resource', () => resource.close());
  await attempt('fixture', () => fixture.close());
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      cleanupErrors,
      'Schedule integration cleanup failed',
    );
}

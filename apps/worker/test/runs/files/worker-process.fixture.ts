import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createDatabaseRuntime } from '@pertexo/database/platform';
import { createOutboxDispatcherDatabase } from '@pertexo/core/outbox';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { createStructuredLogger } from '@pertexo/observability';
import { parseWorkerConfig } from '../../../dist/config/worker.js';
import { createCoordinatorRuntime } from '../../../dist/runs/runtime.js';
import { createNodeAttemptRuntime } from '../../../dist/attempts/delivery/runtime.js';
import { OutboxDispatcher } from '../../../dist/transport/outbox/dispatch/runtime.js';
import { WorkerDrainState } from '../../../dist/runtime/shutdown/drain-state.js';
import { WorkerResourceMonitor } from '../../../dist/runtime/health/resource-monitor.js';

// A separate process excludes the receiver, fixture bytes and test runner from
// the worker's allocation measurements. All runtime settings are real defaults.
const config = parseWorkerConfig(process.env);
const drain = new WorkerDrainState();
const resources = new WorkerResourceMonitor(
  config.resourceSafety,
  drain,
  createStructuredLogger(config.observability),
);
resources.onApplicationBootstrap();
const databaseRuntime = createDatabaseRuntime(config.database, {
  role: 'worker',
});
const maintenanceDatabaseRuntime = createDatabaseRuntime(
  config.dispatcherDatabase,
  { role: 'dispatcher' },
);
const owners: { close(): Promise<unknown> }[] = [
  databaseRuntime,
  maintenanceDatabaseRuntime,
  {
    close: () => {
      resources.beforeApplicationShutdown();
      return Promise.resolve();
    },
  },
];
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let active = 0,
  maximumActive = 0,
  failed = 0;
let sampling = false;
const high = {
  rss: 0,
  heapUsed: 0,
  external: 0,
  arrayBuffers: 0,
  scratchBytes: 0,
  scratchFiles: 0,
};
async function scratchUsage(
  directory: string,
): Promise<{ bytes: number; files: number }> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return [];
      throw error;
    },
  );
  let bytes = 0,
    files = 0;
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await scratchUsage(filename);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      const value = await stat(filename).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return undefined;
        throw error;
      });
      if (value !== undefined) {
        bytes += value.size;
        files++;
      }
    } else throw new Error('Unexpected entry in private scratch');
  }
  return { bytes, files };
}
async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const memory = process.memoryUsage();
    for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers'] as const)
      high[key] = Math.max(high[key], memory[key]);
    const disk = await scratchUsage(config.artifactScratchDirectory);
    high.scratchBytes = Math.max(high.scratchBytes, disk.bytes);
    high.scratchFiles = Math.max(high.scratchFiles, disk.files);
  } finally {
    sampling = false;
  }
}
let timer: NodeJS.Timeout | undefined;
let closing: Promise<void> | undefined;
function close() {
  closing ??= (async () => {
    clearInterval(timer);
    for (const owner of owners.reverse()) await owner.close();
    await sample();
    loop.disable();
    process.send?.({
      phase: 'closed',
      high,
      maximumActive,
      failed,
      resourceDrained: !drain.canAcceptWork(),
      eventLoopP99Millis: loop.percentile(99) / 1e6,
      eventLoopMaxMillis: loop.max / 1e6,
    });
    process.disconnect();
  })();
  return closing;
}
process.once('SIGTERM', () => {
  void close();
});
process.once('disconnect', () => {
  void close();
});
try {
  const coordinator = await createCoordinatorRuntime({
    database: config.database,
    databaseRuntime,
    maintenanceDatabase: config.dispatcherDatabase,
    maintenanceDatabaseRuntime,
    ...config.coordinator,
    redisUrl: config.redisUrl,
  });
  owners.push(coordinator);
  const attempts = await createNodeAttemptRuntime({
    database: config.database,
    databaseRuntime,
    ...config.nodeAttempt,
    redisUrl: config.redisUrl,
    artifactStore: config.artifactStore,
    artifactScratchDirectory: config.artifactScratchDirectory,
    httpRequest: config.httpRequest,
    observer: {
      handlerStarted() {
        active++;
        maximumActive = Math.max(maximumActive, active);
      },
      handlerFinished(observation) {
        active--;
        if (observation.outcome === 'failed') failed++;
      },
    },
  });
  owners.push(attempts);
  const dispatcher = new OutboxDispatcher(
    createOutboxDispatcherDatabase(
      config.dispatcherDatabase,
      maintenanceDatabaseRuntime,
    ),
    createQueueProducer({ redisUrl: config.redisUrl }),
    {
      drainState: drain,
      options: {
        ...config.outboxDispatcher,
        jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
      },
    },
  );
  owners.push(dispatcher);
  await Promise.all([
    coordinator.consumer.waitUntilReady(5000),
    attempts.consumer.waitUntilReady(5000),
  ]);
  dispatcher.start();
  await sample();
  timer = setInterval(() => {
    void sample().then(() =>
      process.send?.({ phase: 'sample', high, active, maximumActive }),
    );
  }, 50);
  process.send?.({
    phase: 'ready',
    limits: {
      pool: config.database.max,
      dispatcherPool: config.dispatcherDatabase.max,
      maximumRssBytes: config.resourceSafety.maximumRssBytes,
      maximumAdmissions: config.coordinator.maximumAdmissions,
    },
  });
} catch (error) {
  await close();
  throw error;
}

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createQueueProducer, QUEUE_NAME } from '@pertexo/queue';

import { Queue } from 'bullmq';
import { it } from 'vitest';

import {
  databaseUrl,
  dispatcherUrl,
  redisConnection,
  redisUrl,
  workerUrl,
  MAXIMUM_CHILD_OUTPUT_BYTES,
  type ChildExit,
  type OwnedChild,
  type ChildStage,
  type StartableChild,
  SPARE_WORKERS,
  stopOwnedChild,
  discardSpares,
} from './fixture.js';
import { createForEachScenario } from './scenario/execute.js';

export function registerRecoversBoundedEachBatchesCancellationPostgreSQL(): void {
  it('recovers bounded For Each batches and cancellation from PostgreSQL on fresh workers', async () => {
    let producer: ReturnType<typeof createQueueProducer> | undefined;
    let coordinatorQueue: Queue | undefined;
    let attemptQueue: Queue | undefined;
    let workers: OwnedChild | undefined;
    const spares: Promise<StartableChild>[] = [];
    try {
      producer = createQueueProducer({ redisUrl });
      coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
        connection: redisConnection(),
      });
      const ownedProducer = producer;
      const ownedCoordinatorQueue = coordinatorQueue;
      const ownedAttemptQueue = attemptQueue;
      // Every restart still uses a new process; loading one ahead hides the
      // module loading that otherwise dominated this test's runtime.
      const refillSpares = () => {
        while (spares.length < SPARE_WORKERS) {
          const spare = loadWorkers();
          // A spare that fails to load is reported when it is taken.
          spare.catch(() => undefined);
          spares.push(spare);
        }
      };
      const startWorkers = async (): Promise<OwnedChild> => {
        refillSpares();
        const next = spares.shift();
        refillSpares();
        if (next === undefined) throw new Error('For Each spare is missing');
        const owner = await next;
        try {
          await owner.start();
          return owner;
        } catch (startupError: unknown) {
          let cleanupError: unknown;
          await stopOwnedChild(owner).catch((error: unknown) => {
            cleanupError = error;
          });
          if (cleanupError === undefined) throw startupError;
          throw new AggregateError(
            [startupError, cleanupError],
            'For Each child startup failed',
          );
        }
      };
      const loadWorkers = async (): Promise<StartableChild> => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL('../for-each-worker-process.fixture.ts', import.meta.url),
            ),
          ],
          {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            env: {
              ...process.env,
              FOR_EACH_DATABASE_URL: databaseUrl(workerUrl),
              FOR_EACH_MAINTENANCE_DATABASE_URL: databaseUrl(dispatcherUrl),
              FOR_EACH_REDIS_URL: redisUrl,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        // The child closes its input after starting; a late close is harmless.
        child.stdin.on('error', () => undefined);
        const exit = new Promise<ChildExit>((resolve) => {
          let settled = false;
          const settle = (result: ChildExit): void => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          child.once('error', (error) => {
            settle({ code: null, error, signal: null });
          });
          child.once('exit', (code, signal) => {
            settle({ code, signal });
          });
        });
        const owner = Object.freeze({ child, exit });
        let pendingLine = '';
        let stderr = '';
        let outputFailure: Error | undefined;
        const reached = new Set<ChildStage>();
        const observers = new Set<() => void>();
        child.stdout.on('data', (chunk: Buffer) => {
          pendingLine += chunk.toString();
          if (Buffer.byteLength(pendingLine) > MAXIMUM_CHILD_OUTPUT_BYTES)
            outputFailure = new Error(
              'For Each child stdout frame is too large',
            );
          const lines = pendingLine.split('\n');
          pendingLine = lines.pop() ?? '';
          for (const line of lines) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              (parsed as { pid?: unknown }).pid !== child.pid
            )
              continue;
            for (const stage of ['loaded', 'ready'] as const)
              if ((parsed as Record<string, unknown>)[stage] === true)
                reached.add(stage);
          }
          for (const observe of observers) observe();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(
            -MAXIMUM_CHILD_OUTPUT_BYTES,
          );
        });
        const reach = (stage: ChildStage) =>
          new Promise<void>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
              settle(new Error(`For Each child ${stage} timed out: ${stderr}`));
            }, 10_000);
            timer.unref();
            const settle = (error?: Error): void => {
              if (settled) return;
              settled = true;
              observers.delete(observe);
              clearTimeout(timer);
              if (error === undefined) resolve();
              else reject(error);
            };
            const observe = (): void => {
              if (outputFailure !== undefined) settle(outputFailure);
              else if (reached.has(stage)) settle();
            };
            observers.add(observe);
            observe();
            void exit.then((result) => {
              if (!reached.has(stage))
                settle(
                  result.error ??
                    new Error(
                      `For Each child exited before ${stage} (${String(result.code)}, ${String(result.signal)}): ${stderr}`,
                    ),
                );
            });
          });
        try {
          await reach('loaded');
          return Object.freeze({
            ...owner,
            start: () => {
              child.stdin.write('start\n');
              return reach('ready');
            },
          });
        } catch (startupError: unknown) {
          let cleanupError: unknown;
          await stopOwnedChild(owner).catch((error: unknown) => {
            cleanupError = error;
          });
          if (cleanupError === undefined) throw startupError;
          throw new AggregateError(
            [startupError, cleanupError],
            'For Each child startup failed',
          );
        }
      };
      workers = await startWorkers();
      const stopWorkers = async () => {
        const activeWorkers = workers;
        if (activeWorkers === undefined) return;
        await stopOwnedChild(activeWorkers);
        workers = undefined;
      };
      const eraseRedisAndRestart = async () => {
        await stopWorkers();
        await Promise.all([
          ownedCoordinatorQueue.obliterate({ force: true }),
          ownedAttemptQueue.obliterate({ force: true }),
        ]);
        workers = await startWorkers();
      };

      // Each scenario runs a workflow through fresh workers and asserts its
      // checkpoint, batches and final run state against PostgreSQL.
      const verifyScenario = createForEachScenario({
        ownedProducer,
        ownedCoordinatorQueue,
        ownedAttemptQueue,
        stopWorkers,
        eraseRedisAndRestart,
      });

      await ownedProducer.waitUntilReady(5_000);
      await verifyScenario('serial_complete');
      await verifyScenario('condition_complete');
      await verifyScenario('switch_complete');
      await verifyScenario('nested_complete');
      await verifyScenario('complete');
      await verifyScenario('cancel_between_batches');
      await verifyScenario('cancel_running');
      await verifyScenario('deadline_running');
    } finally {
      const errors: unknown[] = [];
      const activeWorkers = workers;
      if (activeWorkers !== undefined)
        await stopOwnedChild(activeWorkers).catch((error: unknown) =>
          errors.push(error),
        );
      await discardSpares(spares).catch((error: unknown) => errors.push(error));
      await producer?.close().catch((error: unknown) => errors.push(error));
      await coordinatorQueue
        ?.close()
        .catch((error: unknown) => errors.push(error));
      await attemptQueue?.close().catch((error: unknown) => errors.push(error));
      if (errors.length > 0)
        // Cleanup failures must remain visible even when the scenario failed.
        // eslint-disable-next-line no-unsafe-finally
        throw new AggregateError(
          errors,
          'For Each recovery scenario cleanup failed',
        );
    }
  }, 120_000);
}

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  acceptWorkflowRun,
  appendRunEvent,
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  type WorkspaceDatabase,
} from '@pertexo/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresRunEventReader,
  RedisRunEventPublisher,
  RedisRunEventSource,
  streamRunEventFrames,
} from '../../src/executions/index.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const apiUrl = process.env.DATABASE_API_URL;
const workerUrl = process.env.DATABASE_WORKER_URL;
const redisUrl = process.env.REDIS_URL;
const enabled =
  process.env.API_SSE_RESILIENCE_INTEGRATION === 'true' &&
  apiUrl !== undefined &&
  workerUrl !== undefined &&
  redisUrl !== undefined;

const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const redisPassword = process.env.REDIS_PASSWORD ?? 'pertexo-local-redis';
const databaseConfig = (connectionString: string) =>
  parseDatabaseConfig({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 2,
    ownerRole,
  });

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function initialCheckpoint(engineVersion: string, workflowVersionId: string) {
  return {
    schemaVersion: 1,
    engineVersion,
    workflowVersionId,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: false,
    deadlineExpired: false,
  } as const;
}

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return result.stdout.trim();
}

async function authenticatedPong(): Promise<void> {
  await expect(
    compose(
      'exec',
      '-T',
      'redis',
      'redis-cli',
      '--raw',
      '--no-auth-warning',
      '-a',
      redisPassword,
      'PING',
    ),
  ).resolves.toBe('PONG');
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastValue: T | undefined;
  while (performance.now() < deadline) {
    try {
      lastValue = await read();
      if (predicate(lastValue)) return lastValue;
    } catch {
      // Redis reconnects asynchronously; retry until the bounded deadline.
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for Redis recovery after ${String(timeoutMs)}ms (last value: ${String(lastValue)})`,
  );
}

describe.runIf(enabled)('destructive Redis-loss SSE reconstruction', () => {
  let apiDatabase: WorkspaceDatabase;
  let workerDatabase: WorkspaceDatabase;
  let liveSource: RedisRunEventSource;
  let publisher: RedisRunEventPublisher;

  beforeAll(() => {
    apiDatabase = createWorkspaceDatabase(databaseConfig(apiUrl ?? ''));
    workerDatabase = createWorkspaceDatabase(databaseConfig(workerUrl ?? ''));
    liveSource = new RedisRunEventSource({ redisUrl: redisUrl ?? '' });
    publisher = new RedisRunEventPublisher({
      publishTimeoutMs: 750,
      redisUrl: redisUrl ?? '',
    });
  });

  afterAll(async () => {
    await Promise.all([
      publisher.close(),
      apiDatabase.close(),
      workerDatabase.close(),
    ]);
  });

  it('reconnects after Redis loss and reconstructs durable events exactly once', async () => {
    const workspaceId = randomUUID();
    const identityDatabase = createIdentityWorkspaceDatabase(
      databaseConfig(apiUrl ?? ''),
    );
    try {
      const owner = await identityDatabase.createUser({
        email: `sse-resilience-${workspaceId}@example.test`,
        displayName: 'SSE resilience fixture owner',
      });
      await identityDatabase.createWorkspaceWithOwner({
        id: workspaceId,
        name: 'SSE resilience fixture workspace',
        slug: `sse-resilience-${workspaceId}`,
        ownerUserId: owner.id,
      });
    } finally {
      await identityDatabase.close();
    }
    const engineVersion = 'phase0e-sse-resilience-v1';
    const workflowVersionId = randomUUID();
    const accepted = await apiDatabase.withWorkspace(
      workspaceId,
      async (transaction) =>
        acceptWorkflowRun(transaction, {
          engineVersion,
          initialCheckpoint: initialCheckpoint(
            engineVersion,
            workflowVersionId,
          ),
          keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
          operation: 'workflow.run.accept',
          requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
          scope: `sse-resilience:${workspaceId}`,
          triggerType: 'manual',
          workflowId: randomUUID(),
          workflowVersionId,
        }),
    );
    const runId = accepted.runId;
    const abort = new AbortController();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId,
        signal: abort.signal,
        workspaceId,
      },
      {
        liveSource,
        reader: createPostgresRunEventReader(apiDatabase),
      },
      { pageSize: 1 },
    )[Symbol.asyncIterator]();

    let redisStopAttempted = false;
    const received: number[] = [];
    try {
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 1, event: 'run.queued' },
      });
      received.push(1);

      const preLossSequence = await workerDatabase.withWorkspace(
        workspaceId,
        (transaction) =>
          appendRunEvent(transaction, {
            runId,
            event: { payload: { phase: 'before-loss' }, type: 'run.started' },
          }),
      );
      await publisher.publish({
        runId,
        sequence: preLossSequence,
        workspaceId,
      });
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 2, event: 'run.started' },
      });
      received.push(2);

      // Coordinate immediately before taking the shared dependency down.
      redisStopAttempted = true;
      const stopStartedAt = performance.now();
      await compose('stop', '--timeout', '10', 'redis');
      const stopDurationMs = performance.now() - stopStartedAt;

      const publisherFailureStartedAt = performance.now();
      await expect(
        publisher.publish({ runId, sequence: 3, workspaceId }),
      ).rejects.toThrow();
      const failureDetectionMs = performance.now() - publisherFailureStartedAt;

      const lostSequences: number[] = [];
      for (const event of [
        { payload: { phase: 'redis-down-1' }, type: 'node.ready' as const },
        { payload: { phase: 'redis-down-2' }, type: 'node.started' as const },
      ]) {
        lostSequences.push(
          await workerDatabase.withWorkspace(workspaceId, (transaction) =>
            appendRunEvent(transaction, { event, runId }),
          ),
        );
      }
      expect(lostSequences).toEqual([3, 4]);
      await expect(
        publisher.publish({
          runId,
          sequence: lostSequences[0] ?? 3,
          workspaceId,
        }),
      ).rejects.toThrow();
      await expect(
        publisher.publish({
          runId,
          sequence: lostSequences[1] ?? 4,
          workspaceId,
        }),
      ).rejects.toThrow();

      const restartStartedAt = performance.now();
      await compose('up', '-d', '--wait', 'redis');
      await authenticatedPong();
      const redisHealthRecoveryMs = performance.now() - restartStartedAt;
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 3, event: 'node.ready' },
      });
      received.push(3);
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 4, event: 'node.started' },
      });
      received.push(4);
      const redisBackfillRecoveryMs = performance.now() - restartStartedAt;

      const postRecoverySequence = await workerDatabase.withWorkspace(
        workspaceId,
        (transaction) =>
          appendRunEvent(transaction, {
            runId,
            event: {
              payload: { phase: 'after-recovery' },
              type: 'node.progress',
            },
          }),
      );
      await waitFor(
        () =>
          publisher.publish({
            runId,
            sequence: postRecoverySequence,
            workspaceId,
          }),
        (result) => result.receivers >= 1,
      );
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 5, event: 'node.progress' },
      });
      received.push(5);
      expect(received).toEqual([1, 2, 3, 4, 5]);
      process.stdout.write(
        `${JSON.stringify({
          event: 'phase0e.sse.redis_loss_measurements',
          failureDetectionMs,
          redisBackfillRecoveryMs,
          redisHealthRecoveryMs,
          stopDurationMs,
        })}\n`,
      );
    } finally {
      abort.abort();
      await iterator.return(undefined);
      if (redisStopAttempted) {
        await compose('up', '-d', '--wait', 'redis');
        await authenticatedPong();
      }
    }
  });
});

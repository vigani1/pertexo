import { createHash, randomUUID } from 'node:crypto';

import {
  acceptWorkflowRun,
  appendRunEvent,
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  type WorkspaceDatabase,
} from '@pertexo/database/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresRunEventReader,
  RedisRunEventPublisher,
  RedisRunEventSource,
  streamRunEventFrames,
} from '../../src/executions/index.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../support/fixture-resource-owner.js';
import {
  NO_STREAM_FAILURE,
  preserveFailureDuringStreamCleanup,
  type StreamFailure,
} from '../../src/workflow-runs/stream-cleanup.js';

const apiUrl = process.env.DATABASE_API_URL;
const workerUrl = process.env.DATABASE_WORKER_URL;
const redisUrl = process.env.REDIS_URL;
const enabled =
  process.env.API_SSE_INTEGRATION === 'true' &&
  apiUrl !== undefined &&
  workerUrl !== undefined &&
  redisUrl !== undefined;

const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const databaseConfig = (connectionString: string) =>
  parseDatabaseConfig({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 2,
    ownerRole,
  });
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function recordBenchmarkOperation(startedAt: number): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION_V2=${JSON.stringify({ schemaVersion: 2, name: 'event-live-visibility', startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: 'live event publication through SSE visibility observation' })}\n`,
  );
}

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

describe.runIf(enabled)('real PostgreSQL-authoritative run event SSE', () => {
  const workspaceId = randomUUID();
  let resources: FixtureResourceOwner | undefined;
  let apiDatabase: WorkspaceDatabase;
  let workerDatabase: WorkspaceDatabase;
  let liveSource: RedisRunEventSource;
  let publisher: RedisRunEventPublisher;
  let redis: Redis;
  let runId: string;

  beforeAll(async () => {
    const owner = new FixtureResourceOwner();
    try {
      const identityDatabase = owner.acquire(
        'identity database',
        createIdentityWorkspaceDatabase(databaseConfig(apiUrl ?? '')),
        (database) => database.close(),
      );
      const workspaceOwner = await identityDatabase.createUser({
        email: `sse-${workspaceId}@example.test`,
        displayName: 'SSE fixture owner',
      });
      await identityDatabase.createWorkspaceWithOwner({
        id: workspaceId,
        name: 'SSE fixture workspace',
        slug: `sse-${workspaceId}`,
        ownerUserId: workspaceOwner.id,
      });
      await identityDatabase.close();
      owner.transfer(identityDatabase);
      apiDatabase = owner.acquire(
        'API database',
        createWorkspaceDatabase(databaseConfig(apiUrl ?? '')),
        (database) => database.close(),
      );
      workerDatabase = owner.acquire(
        'worker database',
        createWorkspaceDatabase(databaseConfig(workerUrl ?? '')),
        (database) => database.close(),
      );
      liveSource = new RedisRunEventSource({ redisUrl: redisUrl ?? '' });
      publisher = owner.acquire(
        'event publisher',
        new RedisRunEventPublisher({ redisUrl: redisUrl ?? '' }),
        (selected) => selected.close(),
      );
      redis = owner.acquire(
        'Redis verification client',
        new Redis(redisUrl ?? '', {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        }),
        (client) => {
          client.disconnect(false);
        },
      );
      const engineVersion = 'phase0e-fixture-v1';
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
            keyHash: digest(`key:${workspaceId}`),
            operation: 'workflow.run.accept',
            requestHash: digest(`request:${workspaceId}`),
            scope: `sse-fixture:${workspaceId}`,
            triggerType: 'api',
            workflowId: randomUUID(),
            workflowVersionId,
          }),
      );
      runId = accepted.runId;
      resources = owner;
    } catch (error: unknown) {
      await rethrowFixtureSetupFailure(owner, error);
    }
  });

  afterAll(async () => {
    await resources?.close();
  });

  it('backfills lost Redis hints from PostgreSQL then follows live events exactly once', async () => {
    const secondSequence = await workerDatabase.withWorkspace(
      workspaceId,
      async (transaction) =>
        appendRunEvent(transaction, {
          runId,
          event: { type: 'run.started', payload: { source: 'database' } },
        }),
    );
    const thirdSequence = await workerDatabase.withWorkspace(
      workspaceId,
      async (transaction) =>
        appendRunEvent(transaction, {
          runId,
          event: { type: 'node.ready', payload: { nodeId: 'first' } },
        }),
    );

    // These hints are deliberately published before any subscriber exists.
    // Redis loses them; PostgreSQL remains sufficient to reconstruct history.
    await publisher.publish({
      runId,
      sequence: secondSequence,
      workspaceId,
    });
    await publisher.publish({
      runId,
      sequence: thirdSequence,
      workspaceId,
    });
    await redis.ping();

    const abort = new AbortController();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 1,
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

    let primary: StreamFailure = NO_STREAM_FAILURE;
    try {
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 2, event: 'run.started' },
      });
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 3, event: 'node.ready' },
      });

      const operationStartedAt = performance.now();
      const fourthSequence = await workerDatabase.withWorkspace(
        workspaceId,
        async (transaction) =>
          appendRunEvent(transaction, {
            runId,
            event: { type: 'node.started', payload: { nodeId: 'first' } },
          }),
      );
      await publisher.publish({
        runId,
        sequence: fourthSequence,
        workspaceId,
      });
      await expect(iterator.next()).resolves.toMatchObject({
        value: { id: 4, event: 'node.started' },
      });
      recordBenchmarkOperation(operationStartedAt);
    } catch (error: unknown) {
      primary = { error, failed: true };
      throw error;
    } finally {
      await preserveFailureDuringStreamCleanup(primary, [
        () => {
          abort.abort();
        },
        async () => iterator.return(undefined),
      ]);
    }
  });
});

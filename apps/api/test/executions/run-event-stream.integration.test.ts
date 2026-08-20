import { createHash, randomUUID } from 'node:crypto';

import {
  acceptWorkflowRun,
  appendRunEvent,
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  type WorkspaceDatabase,
} from '@pertexo/database';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresRunEventReader,
  RedisRunEventPublisher,
  RedisRunEventSource,
  streamRunEventFrames,
} from '../../src/executions/index.js';

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
  let apiDatabase: WorkspaceDatabase;
  let workerDatabase: WorkspaceDatabase;
  let liveSource: RedisRunEventSource;
  let publisher: RedisRunEventPublisher;
  let redis: Redis;
  let runId: string;

  beforeAll(async () => {
    const identityDatabase = createIdentityWorkspaceDatabase(
      databaseConfig(apiUrl ?? ''),
    );
    try {
      const owner = await identityDatabase.createUser({
        email: `sse-${workspaceId}@example.test`,
        displayName: 'SSE fixture owner',
      });
      await identityDatabase.createWorkspaceWithOwner({
        id: workspaceId,
        name: 'SSE fixture workspace',
        slug: `sse-${workspaceId}`,
        ownerUserId: owner.id,
      });
    } finally {
      await identityDatabase.close();
    }
    apiDatabase = createWorkspaceDatabase(databaseConfig(apiUrl ?? ''));
    workerDatabase = createWorkspaceDatabase(databaseConfig(workerUrl ?? ''));
    liveSource = new RedisRunEventSource({ redisUrl: redisUrl ?? '' });
    publisher = new RedisRunEventPublisher({ redisUrl: redisUrl ?? '' });
    redis = new Redis(redisUrl ?? '', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
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
  });

  afterAll(async () => {
    redis.disconnect(false);
    await Promise.all([
      publisher.close(),
      apiDatabase.close(),
      workerDatabase.close(),
    ]);
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

    await expect(iterator.next()).resolves.toMatchObject({
      value: { id: 2, event: 'run.started' },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { id: 3, event: 'node.ready' },
    });

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

    abort.abort();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

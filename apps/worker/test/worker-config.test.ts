import { describe, expect, it } from 'vitest';
import { JOB_NAME } from '@pertexo/queue';

import { parseWorkerConfig } from '../src/config/worker-config.js';

describe('parseWorkerConfig', () => {
  it('applies safe defaults when optional environment values are absent', () => {
    expect(
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
      }),
    ).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
      },
      dispatcherDatabase: {
        connectionString:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: 'pertexo_owner',
      },
      nodeEnv: 'development',
      logLevel: 'info',
      observability: {
        environment: 'development',
        logLevel: 'info',
        otlpHeaders: {},
        serviceName: 'pertexo-worker',
        serviceVersion: '0.0.0-dev',
      },
      outboxDispatcher: {
        batchSize: 25,
        enabledJobNames: [],
        leaseDurationMillis: 30_000,
        leaseOwner: 'outbox:worker-local',
        maxAttempts: 10,
        operationTimeoutMillis: 5_000,
        pollIntervalMillis: 250,
        retryDelayMillis: 1_000,
      },
      redisUrl: 'redis://:secret@localhost:6379/0',
    });
  });

  it('returns the typed worker settings for valid environment values', () => {
    const config = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      REDIS_URL: 'redis://:secret@localhost:6379/0',
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
    });

    expect(config).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
      },
      dispatcherDatabase: {
        connectionString:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: 'pertexo_owner',
      },
      nodeEnv: 'test',
      logLevel: 'debug',
      observability: {
        environment: 'test',
        logLevel: 'debug',
        otlpHeaders: {},
        serviceName: 'pertexo-worker',
        serviceVersion: '0.0.0-dev',
      },
      outboxDispatcher: {
        batchSize: 25,
        enabledJobNames: [],
        leaseDurationMillis: 30_000,
        leaseOwner: 'outbox:worker-local',
        maxAttempts: 10,
        operationTimeoutMillis: 5_000,
        pollIntervalMillis: 250,
        retryDelayMillis: 1_000,
      },
      redisUrl: 'redis://:secret@localhost:6379/0',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it('rejects an unsupported log level before the worker starts', () => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
        LOG_LEVEL: 'verbose',
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it('accepts a nonempty unique allowlist of Phase 2 dispatch capabilities', () => {
    const config = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      REDIS_URL: 'redis://:secret@localhost:6379/0',
      OUTBOX_DISPATCH_JOB_NAMES: [
        JOB_NAME.expireArtifacts,
        JOB_NAME.advanceWorkflowRun,
      ].join(','),
    });

    expect(config.outboxDispatcher.enabledJobNames).toEqual([
      JOB_NAME.expireArtifacts,
      JOB_NAME.advanceWorkflowRun,
    ]);
    expect(Object.isFrozen(config.outboxDispatcher.enabledJobNames)).toBe(true);
  });

  it.each([
    `${JOB_NAME.advanceWorkflowRun},${JOB_NAME.advanceWorkflowRun}`,
    JOB_NAME.reconcileWorkflowTriggers,
    'unknown-job',
  ])('rejects an invalid dispatcher allowlist (%s)', (jobNames) => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
        OUTBOX_DISPATCH_JOB_NAMES: jobNames,
      }),
    ).toThrow(/invalid worker configuration/i);
  });
});

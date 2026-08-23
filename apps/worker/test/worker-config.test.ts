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
      coordinator: { maximumAdmissions: 32 },
      database: {
        connectionString:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      dispatcherDatabase: {
        connectionString:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      nodeEnv: 'development',
      nodeCompatibilityCohort: 'core',
      logLevel: 'info',
      nodeAttempt: {
        heartbeatIntervalMillis: 10_000,
        leaseDurationSeconds: 30,
        workerId: 'worker-local',
      },
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
      NODE_COMPATIBILITY_COHORT: 'http_staging',
      LOG_LEVEL: 'debug',
      POSTGRES_WORKER_RUNTIME_USER: 'custom_worker',
    });

    expect(config).toEqual({
      coordinator: { maximumAdmissions: 32 },
      database: {
        connectionString:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'custom_worker',
      },
      dispatcherDatabase: {
        connectionString:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'custom_worker',
      },
      nodeEnv: 'test',
      nodeCompatibilityCohort: 'http_staging',
      logLevel: 'debug',
      nodeAttempt: {
        heartbeatIntervalMillis: 10_000,
        leaseDurationSeconds: 30,
        workerId: 'worker-local',
      },
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
    expect(Object.isFrozen(config.coordinator)).toBe(true);
    expect(Object.isFrozen(config.nodeAttempt)).toBe(true);
  });

  it('parses optional worker connection and artifact capability configuration', () => {
    const config = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      REDIS_URL: 'redis://:secret@localhost:6379/0',
      CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
      CONNECTION_KMS_REGION: 'eu-central-1',
      CONNECTION_KMS_ENDPOINT: 'http://localhost:4566',
      ARTIFACT_STORE_ACCESS_KEY_ID: 'local-access',
      ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
      ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
      ARTIFACT_STORE_REGION: 'us-east-1',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'local-secret',
    });

    expect(config.connectionEncryption).toEqual({
      keyReference: 'alias/pertexo-connections',
      region: 'eu-central-1',
      endpoint: 'http://localhost:4566',
    });
    expect(config.artifactStore).toMatchObject({
      bucket: 'pertexo-artifacts',
      endpoint: 'http://localhost:9090',
      maxObjectBytes: 10_485_760,
    });
    expect(Object.isFrozen(config.connectionEncryption)).toBe(true);
    expect(Object.isFrozen(config.artifactStore)).toBe(true);
  });

  it('fails closed when an HTTP activation execution worker lacks required capabilities', () => {
    let thrown: unknown;
    try {
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
        NODE_COMPATIBILITY_COHORT: 'http_activation',
        OUTBOX_DISPATCH_JOB_NAMES: JOB_NAME.executeNodeAttempt,
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Invalid worker configuration');
    expect((thrown as Error).cause).toEqual(
      new Error(
        'HTTP activation workers require connection encryption and artifact storage',
      ),
    );
  });

  it.each([
    { CONNECTION_KMS_KEY_REFERENCE: 'alias/incomplete' },
    { ARTIFACT_STORE_BUCKET: 'pertexo-artifacts' },
    {
      NODE_ENV: 'production',
      CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
      CONNECTION_KMS_REGION: 'eu-central-1',
      CONNECTION_KMS_ENDPOINT: 'http://kms.example.test',
    },
  ])('rejects incomplete or insecure capability configuration', (override) => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
        ...override,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it.each(['0', '65', '1.5'])(
    'rejects an invalid coordinator admission bound (%s)',
    (maximumAdmissions) => {
      expect(() =>
        parseWorkerConfig({
          DATABASE_DISPATCHER_URL:
            'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
          DATABASE_WORKER_URL:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          REDIS_URL: 'redis://:secret@localhost:6379/0',
          WORKFLOW_COORDINATOR_MAX_ADMISSIONS: maximumAdmissions,
        }),
      ).toThrow(/invalid worker configuration/i);
    },
  );

  it('rejects a node-attempt heartbeat that cannot renew before lease expiry', () => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
        NODE_ATTEMPT_LEASE_SECONDS: '5',
        NODE_ATTEMPT_HEARTBEAT_MILLIS: '5000',
      }),
    ).toThrow(/invalid worker configuration/i);
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

  it('accepts a nonempty unique allowlist of supported dispatch capabilities', () => {
    const config = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      REDIS_URL: 'redis://:secret@localhost:6379/0',
      OUTBOX_DISPATCH_JOB_NAMES: [
        JOB_NAME.expireArtifacts,
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcilePreviewAttempt,
      ].join(','),
    });

    expect(config.outboxDispatcher.enabledJobNames).toEqual([
      JOB_NAME.expireArtifacts,
      JOB_NAME.advanceWorkflowRun,
      JOB_NAME.reconcilePreviewAttempt,
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

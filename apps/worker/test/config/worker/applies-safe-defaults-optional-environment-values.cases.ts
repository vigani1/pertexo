import { DEFAULT_CODE_SETTINGS, codeRunnerSocketPath } from '@pertexo/node-sdk';

import { expect, it } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/worker.js';
import { databaseEnvironment, requiredEnvironment } from './fixture.js';

export function registerAppliesSafeDefaultsOptionalEnvironmentValues(): void {
  it('applies safe defaults when optional environment values are absent', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
      }),
    ).toEqual({
      artifactScratchDirectory: '/var/lib/pertexo/artifact-scratch',
      httpRequest: { allowedPrivateNetworks: [] },
      codeRunner: {
        settings: DEFAULT_CODE_SETTINGS,
        socketPath: codeRunnerSocketPath({
          configured: undefined,
          hardened: false,
          uid: process.getuid?.() ?? 'local',
        }),
        requireHardened: false,
      },
      artifactStore: {
        accessKeyId: 'local-access',
        bucket: 'pertexo-artifacts',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        maxObjectBytes: 10_485_760,
        region: 'us-east-1',
        requestTimeoutMs: expect.any(Number) as number,
        secretAccessKey: 'local-secret',
      },
      retention: {
        maintenanceDatabase: expect.objectContaining({
          connectionString:
            'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
        }) as unknown,
      },
      coordinator: {
        dueWakeupBatchSize: 25,
        dueWakeupPollIntervalMillis: 250,
        maximumAdmissions: 32,
      },
      workspaceInbox: {
        foldBatchSize: 500,
        foldPollMillis: 1_000,
      },
      workflowAutoPause: {
        foldBatchSize: 500,
        foldPollMillis: 1_000,
      },
      database: {
        connectionString:
          'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
      },
      dispatcherDatabase: {
        connectionString:
          'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: 'pertexo_owner',
      },
      nodeEnv: 'development',
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
        leaseDurationMillis: 30_000,
        leaseOwner: 'outbox:worker-local',
        operationTimeoutMillis: 5_000,
        pollIntervalMillis: 250,
        retryDelayMillis: 1_000,
      },
      triggerRuntime: {
        batchSize: 25,
        leaseDurationSeconds: 30,
        leaseOwner: 'schedule:worker-local',
        onTimeWindowSeconds: 300,
        pollIntervalMillis: 250,
      },
      redisUrl: 'redis://:secret@localhost:6379/0',
      resourceSafety: {
        maximumEventLoopDelayMillis: 200,
        maximumRssBytes: 805_306_368,
        sampleIntervalMillis: 5_000,
        unhealthySamplesBeforeDrain: 3,
      },
    });
  });

  it('returns the typed worker settings for valid environment values', () => {
    const config = parseWorkerConfig({
      ...requiredEnvironment,
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
    });

    expect(config).toMatchObject({
      database: {
        connectionString:
          'postgresql://pertexo_app:secret@localhost:5432/pertexo',
      },
      dispatcherDatabase: {
        connectionString:
          'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
      },
      logLevel: 'debug',
      nodeEnv: 'test',
      observability: { environment: 'test', logLevel: 'debug' },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.coordinator)).toBe(true);
    expect(Object.isFrozen(config.nodeAttempt)).toBe(true);
    expect(Object.isFrozen(config.resourceSafety)).toBe(true);
  });

  it.each([100, '100', 2_147_483_647, '2147483647'])(
    'accepts a resource sampling interval supported by Node timers (%s)',
    (sampleIntervalMillis) => {
      expect(
        parseWorkerConfig({
          ...requiredEnvironment,
          WORKER_RESOURCE_SAMPLE_MILLIS: sampleIntervalMillis,
        }).resourceSafety.sampleIntervalMillis,
      ).toBe(Number(sampleIntervalMillis));
    },
  );

  it.each([99, '2147483648', 100.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid or overflowing resource sampling interval (%s)',
    (sampleIntervalMillis) => {
      expect(() =>
        parseWorkerConfig({
          ...requiredEnvironment,
          WORKER_RESOURCE_SAMPLE_MILLIS: sampleIntervalMillis,
        }),
      ).toThrow(/invalid worker configuration/iu);
    },
  );

  it('parses optional worker connection and artifact capability configuration', () => {
    const config = parseWorkerConfig({
      ...requiredEnvironment,
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

  it('requires artifact storage', () => {
    expect(() => parseWorkerConfig(databaseEnvironment)).toThrow(
      'Invalid worker configuration',
    );
  });

  it('rejects incomplete connection encryption configuration', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        CONNECTION_KMS_KEY_REFERENCE: 'alias/incomplete',
      }),
    ).toThrow(/invalid worker configuration/i);
  });
}

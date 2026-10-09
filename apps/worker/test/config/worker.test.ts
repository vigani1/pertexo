import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseWorkerConfig } from '../../src/config/worker.js';

const databaseEnvironment = {
  DATABASE_MAINTENANCE_URL:
    'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
  DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
  REDIS_URL: 'redis://:secret@localhost:6379/0',
} as const;
const requiredEnvironment = {
  ...databaseEnvironment,
  ARTIFACT_STORE_ACCESS_KEY_ID: 'local-access',
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
  ARTIFACT_STORE_REGION: 'us-east-1',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'local-secret',
} as const;

describe('parseWorkerConfig', () => {
  it('parses the dedicated authentication-mail worker configuration', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        WORKER_INSTANCE_ID: 'mail-worker-1',
        AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
        AUTH_MAIL_KEY: Buffer.alloc(32, 4).toString('base64'),
        AUTH_MAIL_KEY_VERSION: 'mail-v1',
      }).authenticationMailDelivery,
    ).toMatchObject({
      apiKey: 'provider-key',
      timeoutMillis: 5_000,
      pollIntervalMillis: 1_000,
      workerId: 'auth-mail:mail-worker-1',
      encryption: { current: { version: 'mail-v1' } },
    });
  });

  it('fails closed when authentication-mail delivery is partially configured', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('requires authentication-mail delivery in a deployed worker', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test/v1',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('applies safe defaults when optional environment values are absent', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
      }),
    ).toEqual({
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
        maxAttempts: 10,
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

  it('reaches the deployed KMS protocol policy after valid production telemetry parsing', () => {
    let thrown: unknown;
    try {
      parseWorkerConfig({
        ...requiredEnvironment,
        CONNECTION_KMS_ENDPOINT: 'http://kms.example.test',
        CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
        CONNECTION_KMS_REGION: 'eu-central-1',
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test/v1',
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toEqual(
      new Error('HTTPS connection KMS endpoint is required when deployed'),
    );
  });

  it('accepts HTTPS artifact storage and runs retention when deployed', () => {
    const selected = parseWorkerConfig({
      ...requiredEnvironment,
      ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
      ARTIFACT_STORE_BUCKET: 'primary-artifacts',
      ARTIFACT_STORE_ENDPOINT: 'https://artifacts.example.test',
      ARTIFACT_STORE_REGION: 'eu-central-1',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
      CONNECTION_KMS_REGION: 'eu-central-1',
      NODE_ENV: 'production',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test/v1',
      AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
      AUTH_MAIL_KEY: Buffer.alloc(32, 4).toString('base64'),
      AUTH_MAIL_KEY_VERSION: 'mail-v1',
    });

    expect(selected.artifactStore.endpoint).toBe(
      'https://artifacts.example.test',
    );
    expect(selected.retention.maintenanceDatabase).toBeDefined();
  });

  it('rejects a partially configured artifact store', () => {
    expect(() =>
      parseWorkerConfig({
        ...databaseEnvironment,
        ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
        ARTIFACT_STORE_BUCKET: 'primary-artifacts',
        ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
        ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('runs retention through the maintenance database', () => {
    expect(
      parseWorkerConfig(requiredEnvironment).retention.maintenanceDatabase,
    ).toMatchObject({
      connectionString: requiredEnvironment.DATABASE_MAINTENANCE_URL,
      max: 2,
    });
  });

  it('normalizes supported scalar environment values before nested parsing', () => {
    const selected = parseWorkerConfig({
      ...requiredEnvironment,
      ARTIFACT_MAX_BYTES: 2_048,
      ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
      ARTIFACT_STORE_BUCKET: 'primary-artifacts',
      ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
      ARTIFACT_STORE_FORCE_PATH_STYLE: true,
      ARTIFACT_STORE_REGION: 'us-east-1',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      DATABASE_POOL_MAX: 7,
      WORKER_RESOURCE_UNHEALTHY_SAMPLES: 4,
    });

    expect(selected.database.max).toBe(7);
    expect(selected.resourceSafety.unhealthySamplesBeforeDrain).toBe(4);
    expect(selected.artifactStore.forcePathStyle).toBe(true);
    expect(selected.artifactStore.maxObjectBytes).toBe(2_048);
  });

  it('rejects non-scalar environment values before capability parsing', () => {
    let thrown: unknown;
    try {
      parseWorkerConfig({
        ...requiredEnvironment,
        CONNECTION_KMS_KEY_REFERENCE: ['alias/not-scalar'],
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toEqual(
      new TypeError('Worker environment values must be scalar'),
    );
  });

  it.each(['0', '65', '1.5'])(
    'rejects an invalid coordinator admission bound (%s)',
    (maximumAdmissions) => {
      expect(() =>
        parseWorkerConfig({
          ...requiredEnvironment,
          WORKFLOW_COORDINATOR_MAX_ADMISSIONS: maximumAdmissions,
        }),
      ).toThrow(/invalid worker configuration/i);
    },
  );

  it('tunes the auto-pause fold loop', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE: '250',
        WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS: '2000',
      }).workflowAutoPause,
    ).toEqual({ foldBatchSize: 250, foldPollMillis: 2_000 });
  });

  it.each([
    ['WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE', '0'],
    ['WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS', '99'],
  ])('rejects an invalid auto-pause setting (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it('tunes the workspace inbox fold loop', () => {
    const config = parseWorkerConfig({
      ...requiredEnvironment,
      WORKSPACE_INBOX_FOLD_BATCH_SIZE: '1000',
      WORKSPACE_INBOX_FOLD_POLL_MILLIS: '250',
    });

    expect(config.workspaceInbox).toEqual({
      foldBatchSize: 1_000,
      foldPollMillis: 250,
    });
  });

  it.each([
    ['WORKSPACE_INBOX_FOLD_BATCH_SIZE', '0'],
    ['WORKSPACE_INBOX_FOLD_BATCH_SIZE', '1001'],
    ['WORKSPACE_INBOX_FOLD_POLL_MILLIS', '99'],
  ])('rejects an invalid workspace inbox setting (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it.each([
    ['WORKFLOW_DUE_WAKEUP_BATCH_SIZE', '0'],
    ['WORKFLOW_DUE_WAKEUP_BATCH_SIZE', '101'],
    ['WORKFLOW_DUE_WAKEUP_POLL_MILLIS', '9'],
    ['WORKFLOW_DUE_WAKEUP_POLL_MILLIS', '60001'],
  ])('rejects an invalid due-wakeup scanner bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it.each([
    ['TRIGGER_SCHEDULE_BATCH_SIZE', '0'],
    ['TRIGGER_SCHEDULE_BATCH_SIZE', '101'],
    ['TRIGGER_SCHEDULE_LEASE_SECONDS', '0'],
    ['TRIGGER_SCHEDULE_LEASE_SECONDS', '301'],
    ['TRIGGER_SCHEDULE_POLL_MILLIS', '9'],
    ['TRIGGER_SCHEDULE_POLL_MILLIS', '60001'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', '59'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', '3601'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', '300.5'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', 'five minutes'],
  ])('rejects an invalid trigger scanner bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it.each([
    ['60', '60000', 60],
    ['3600', '10', 3_600],
  ])(
    'accepts a schedule on-time window at its bounds (%s s, poll %s ms)',
    (window, poll, expected) => {
      expect(
        parseWorkerConfig({
          ...requiredEnvironment,
          TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS: window,
          TRIGGER_SCHEDULE_POLL_MILLIS: poll,
        }).triggerRuntime,
      ).toMatchObject({
        onTimeWindowSeconds: expected,
        pollIntervalMillis: Number(poll),
      });
    },
  );

  it('never lets the schedule on-time window fall below the poll interval', () => {
    // The individual bounds already imply this (a window of at least a minute,
    // a poll of at most one), so it is shown with a poll past its own bound.
    let thrown: unknown;
    try {
      parseWorkerConfig({
        ...requiredEnvironment,
        TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS: '60',
        TRIGGER_SCHEDULE_POLL_MILLIS: '60001',
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as Error).cause;
    expect(cause).toBeInstanceOf(ZodError);
    expect(
      (cause as ZodError).issues.map(({ path, message }) => ({
        path,
        message,
      })),
    ).toContainEqual({
      path: ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS'],
      message: 'Schedule on-time window must not be shorter than its poll',
    });
  });

  it('rejects a node-attempt heartbeat that cannot renew before lease expiry', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        NODE_ATTEMPT_LEASE_SECONDS: '5',
        NODE_ATTEMPT_HEARTBEAT_MILLIS: '5000',
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it('accepts the last heartbeat millisecond before lease expiry', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        NODE_ATTEMPT_HEARTBEAT_MILLIS: 4_999,
        NODE_ATTEMPT_LEASE_SECONDS: 5,
      }).nodeAttempt,
    ).toEqual({
      heartbeatIntervalMillis: 4_999,
      leaseDurationSeconds: 5,
      workerId: 'worker-local',
    });
  });

  it.each([
    ['WORKER_MAX_EVENT_LOOP_DELAY_MILLIS', 0],
    ['WORKER_MAX_RSS_BYTES', 0],
    ['WORKER_RESOURCE_UNHEALTHY_SAMPLES', 0],
    ['WORKER_RESOURCE_UNHEALTHY_SAMPLES', 13],
  ] as const)('rejects an invalid resource bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({ ...requiredEnvironment, [name]: value }),
    ).toThrow(/invalid worker configuration/iu);
  });

  it('rejects an unsupported log level before the worker starts', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        LOG_LEVEL: 'verbose',
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it('starts from the shared local example environment', () => {
    // Developers copy .env.example to .env and start the API and worker from it.
    const config = parseWorkerConfig(
      parseEnv(
        readFileSync(
          new URL('../../../../.env.example', import.meta.url),
          'utf8',
        ),
      ),
    );

    expect(config.nodeEnv).toBe('development');
    expect(config.invitationDelivery).toBeUndefined();
    expect(config.retention.maintenanceDatabase).toBeDefined();
  });
});

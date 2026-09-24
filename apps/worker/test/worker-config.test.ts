import { describe, expect, it } from 'vitest';
import { JOB_NAME } from '@pertexo/queue';

import { parseWorkerConfig } from '../src/config/worker-config.js';

const requiredEnvironment = {
  DATABASE_DISPATCHER_URL:
    'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
  DATABASE_WORKER_URL:
    'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
  REDIS_URL: 'redis://:secret@localhost:6379/0',
} as const;

describe('parseWorkerConfig', () => {
  it('parses the dedicated authentication-mail worker configuration', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        WORKER_INSTANCE_ID: 'mail-worker-1',
        AUTH_MAIL_DELIVERY_ENABLED: 'true',
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
        AUTH_MAIL_DELIVERY_ENABLED: 'true',
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
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
      }),
    ).toEqual({
      coordinator: {
        dueWakeupBatchSize: 25,
        dueWakeupPollIntervalMillis: 250,
        maximumAdmissions: 32,
        runTimeoutFailureContextEnabled: false,
      },
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
      triggerRuntime: {
        batchSize: 25,
        leaseDurationSeconds: 30,
        leaseOwner: 'schedule:worker-local',
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

    expect(config).toMatchObject({
      database: { workerRuntimeRole: 'custom_worker' },
      dispatcherDatabase: { workerRuntimeRole: 'custom_worker' },
      logLevel: 'debug',
      nodeCompatibilityCohort: 'http_staging',
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
      ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'recovery-access',
      ARTIFACT_STORE_RECOVERY_BUCKET: 'pertexo-artifacts-recovery',
      ARTIFACT_STORE_RECOVERY_ENDPOINT: 'http://localhost:9090',
      ARTIFACT_STORE_RECOVERY_REGION: 'us-west-2',
      ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
    });

    expect(config.connectionEncryption).toEqual({
      keyReference: 'alias/pertexo-connections',
      region: 'eu-central-1',
      endpoint: 'http://localhost:4566',
    });
    expect(config.artifactStore).toMatchObject({
      primary: {
        bucket: 'pertexo-artifacts',
        endpoint: 'http://localhost:9090',
        maxObjectBytes: 10_485_760,
      },
      recovery: {
        bucket: 'pertexo-artifacts-recovery',
        endpoint: 'http://localhost:9090',
        maxObjectBytes: 10_485_760,
      },
    });
    expect(Object.isFrozen(config.connectionEncryption)).toBe(true);
    expect(Object.isFrozen(config.artifactStore)).toBe(true);
  });

  it.each([
    'http_activation',
    'condition_activation',
    'switch_activation',
    'merge_activation',
    'for_each_staging',
    'for_each_activation',
  ] as const)(
    'fails closed when a %s execution worker lacks required HTTP capabilities',
    (nodeCompatibilityCohort) => {
      let thrown: unknown;
      try {
        parseWorkerConfig({
          DATABASE_DISPATCHER_URL:
            'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
          DATABASE_WORKER_URL:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          REDIS_URL: 'redis://:secret@localhost:6379/0',
          NODE_COMPATIBILITY_COHORT: nodeCompatibilityCohort,
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
    },
  );

  it.each([
    { CONNECTION_KMS_KEY_REFERENCE: 'alias/incomplete' },
    { ARTIFACT_STORE_BUCKET: 'pertexo-artifacts' },
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

  it('accepts complete HTTPS artifact storage when deployed', () => {
    const selected = parseWorkerConfig({
      ...requiredEnvironment,
      ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
      ARTIFACT_STORE_BUCKET: 'primary-artifacts',
      ARTIFACT_STORE_ENDPOINT: 'https://artifacts.example.test',
      ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'recovery-access',
      ARTIFACT_STORE_RECOVERY_BUCKET: 'recovery-artifacts',
      ARTIFACT_STORE_RECOVERY_ENDPOINT:
        'https://recovery-artifacts.example.test',
      ARTIFACT_STORE_RECOVERY_REGION: 'eu-west-1',
      ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
      ARTIFACT_STORE_REGION: 'eu-central-1',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      NODE_ENV: 'production',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test/v1',
      AUTH_MAIL_DELIVERY_ENABLED: 'true',
      AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
      AUTH_MAIL_KEY: Buffer.alloc(32, 4).toString('base64'),
      AUTH_MAIL_KEY_VERSION: 'mail-v1',
    });

    expect(selected.artifactStore?.primary.endpoint).toBe(
      'https://artifacts.example.test',
    );
    expect(selected.artifactStore?.recovery.endpoint).toBe(
      'https://recovery-artifacts.example.test',
    );
  });

  it('rejects a partially configured recovery artifact store', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
        ARTIFACT_STORE_BUCKET: 'primary-artifacts',
        ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
        ARTIFACT_STORE_RECOVERY_BUCKET: 'recovery-artifacts',
        ARTIFACT_STORE_REGION: 'us-east-1',
        ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('normalizes supported scalar environment values before nested parsing', () => {
    const selected = parseWorkerConfig({
      ...requiredEnvironment,
      ARTIFACT_MAX_BYTES: 2_048,
      ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
      ARTIFACT_STORE_BUCKET: 'primary-artifacts',
      ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
      ARTIFACT_STORE_FORCE_PATH_STYLE: true,
      ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'recovery-access',
      ARTIFACT_STORE_RECOVERY_BUCKET: 'recovery-artifacts',
      ARTIFACT_STORE_RECOVERY_ENDPOINT: 'http://localhost:9091',
      ARTIFACT_STORE_RECOVERY_FORCE_PATH_STYLE: false,
      ARTIFACT_STORE_RECOVERY_REGION: 'us-west-2',
      ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
      ARTIFACT_STORE_REGION: 'us-east-1',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      DATABASE_POOL_MAX: 7,
      WORKER_RESOURCE_UNHEALTHY_SAMPLES: 4,
    });

    expect(selected.database.max).toBe(7);
    expect(selected.resourceSafety.unhealthySamplesBeforeDrain).toBe(4);
    expect(selected.artifactStore?.primary.forcePathStyle).toBe(true);
    expect(selected.artifactStore?.recovery.forcePathStyle).toBe(false);
    expect(selected.artifactStore?.primary.maxObjectBytes).toBe(2_048);
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

  it('enables run-timeout failure context production only explicitly', () => {
    const config = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      REDIS_URL: 'redis://:secret@localhost:6379/0',
      FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED: 'true',
    });

    expect(config.coordinator.runTimeoutFailureContextEnabled).toBe(true);
  });

  it.each(['TRUE', '1', 'yes', 'enabled'])(
    'rejects an ambiguous run-timeout context activation value (%s)',
    (value) => {
      expect(() =>
        parseWorkerConfig({
          DATABASE_DISPATCHER_URL:
            'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
          DATABASE_WORKER_URL:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          REDIS_URL: 'redis://:secret@localhost:6379/0',
          FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED: value,
        }),
      ).toThrow(/invalid worker configuration/i);
    },
  );

  it.each([
    ['WORKFLOW_DUE_WAKEUP_BATCH_SIZE', '0'],
    ['WORKFLOW_DUE_WAKEUP_BATCH_SIZE', '101'],
    ['WORKFLOW_DUE_WAKEUP_POLL_MILLIS', '9'],
    ['WORKFLOW_DUE_WAKEUP_POLL_MILLIS', '60001'],
  ])('rejects an invalid due-wakeup scanner bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
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
  ])('rejects an invalid trigger scanner bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis://:secret@localhost:6379/0',
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

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
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcilePreviewAttempt,
        JOB_NAME.reconcileWorkflowTriggers,
      ].join(','),
    });

    expect(config.outboxDispatcher.enabledJobNames).toEqual([
      JOB_NAME.advanceWorkflowRun,
      JOB_NAME.reconcilePreviewAttempt,
      JOB_NAME.reconcileWorkflowTriggers,
    ]);
    expect(Object.isFrozen(config.outboxDispatcher.enabledJobNames)).toBe(true);
  });

  it.each([
    `${JOB_NAME.advanceWorkflowRun},${JOB_NAME.advanceWorkflowRun}`,
    JOB_NAME.expireArtifacts,
    JOB_NAME.sweepExpiredPreviews,
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

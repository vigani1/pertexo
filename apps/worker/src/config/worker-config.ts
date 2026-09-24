import { z } from 'zod';
import {
  parseDualRegionArtifactStoreConfig,
  type DualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import type { AwsConnectionEnvelopeEncryptionConfig } from '@pertexo/integrations/server';
import {
  PLATFORM_RELEASE_COHORTS,
  platformServingReleaseRequiresHttpCapabilities,
} from '@pertexo/node-catalog';
import { parseObservabilityConfig } from '@pertexo/observability/config';
import { ACTIVE_QUEUE_JOB_NAMES, JOB_NAME, type JobName } from '@pertexo/queue';

const workerEnvironments = [
  'development',
  'test',
  'staging',
  'production',
] as const;

const workerLogLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
] as const;

const supportedDispatchCapabilitySet = new Set<JobName>(ACTIVE_QUEUE_JOB_NAMES);

export function isSupportedDispatchCapability(jobName: JobName): boolean {
  return supportedDispatchCapabilitySet.has(jobName);
}

const enabledJobNamesSchema = z
  .string()
  .transform((value) =>
    value.trim() === ''
      ? []
      : value.split(',').map((jobName) => jobName.trim()),
  )
  .pipe(z.array(z.enum(JOB_NAME)))
  .superRefine((jobNames, context) => {
    if (new Set(jobNames).size !== jobNames.length) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatcher job names must be unique',
      });
    }
    for (const jobName of jobNames) {
      if (!isSupportedDispatchCapability(jobName)) {
        context.addIssue({
          code: 'custom',
          message: `Job kind is not supported by this dispatcher build: ${jobName}`,
        });
      }
    }
  })
  .transform((jobNames) => Object.freeze([...jobNames]));

const workerConfigSchema = z
  .object({
    DATABASE_WORKER_URL: z
      .url()
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'DATABASE_WORKER_URL must be a postgresql:// URL',
      }),
    DATABASE_DISPATCHER_URL: z
      .url()
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'DATABASE_DISPATCHER_URL must be a postgresql:// URL',
      }),
    DATABASE_CONNECTION_TIMEOUT_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    DATABASE_IDLE_TIMEOUT_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .default(30_000),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(20).default(5),
    DATABASE_DISPATCHER_POOL_MAX: z.coerce
      .number()
      .int()
      .positive()
      .max(10)
      .default(2),
    REDIS_URL: z
      .url()
      .refine(
        (value) =>
          value.startsWith('redis://') || value.startsWith('rediss://'),
        {
          message: 'REDIS_URL must be a redis:// or rediss:// URL',
        },
      ),
    OUTBOX_DISPATCH_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    OUTBOX_DISPATCH_JOB_NAMES: enabledJobNamesSchema.default(Object.freeze([])),
    OUTBOX_DISPATCH_LEASE_MILLIS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    OUTBOX_DISPATCH_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(10),
    OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS: z.coerce
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(5_000),
    OUTBOX_DISPATCH_POLL_MILLIS: z.coerce
      .number()
      .int()
      .min(10)
      .max(60_000)
      .default(250),
    OUTBOX_DISPATCH_RETRY_MILLIS: z.coerce
      .number()
      .int()
      .min(1)
      .max(300_000)
      .default(1_000),
    WORKFLOW_COORDINATOR_MAX_ADMISSIONS: z.coerce
      .number()
      .int()
      .min(1)
      .max(64)
      .default(32),
    FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    WORKFLOW_DUE_WAKEUP_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    WORKFLOW_DUE_WAKEUP_POLL_MILLIS: z.coerce
      .number()
      .int()
      .min(10)
      .max(60_000)
      .default(250),
    TRIGGER_SCHEDULE_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    TRIGGER_SCHEDULE_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(300)
      .default(30),
    TRIGGER_SCHEDULE_POLL_MILLIS: z.coerce
      .number()
      .int()
      .min(10)
      .max(60_000)
      .default(250),
    NODE_ATTEMPT_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(300)
      .default(30),
    NODE_ATTEMPT_HEARTBEAT_MILLIS: z.coerce
      .number()
      .int()
      .min(10)
      .max(299_999)
      .default(10_000),
    WORKER_INSTANCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,96}$/u)
      .default('worker-local'),
    AUTH_MAIL_DELIVERY_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    NODE_ENV: z.enum(workerEnvironments).default('development'),
    NODE_COMPATIBILITY_COHORT: z.enum(PLATFORM_RELEASE_COHORTS).default('core'),
    LOG_LEVEL: z.enum(workerLogLevels).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
    WORKER_MAX_EVENT_LOOP_DELAY_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .default(200),
    WORKER_MAX_RSS_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(805_306_368),
    WORKER_RESOURCE_SAMPLE_MILLIS: z.coerce
      .number()
      .int()
      .min(100)
      .max(2_147_483_647)
      .default(5_000),
    WORKER_RESOURCE_UNHEALTHY_SAMPLES: z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .default(3),
    POSTGRES_OWNER_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/u)
      .default('pertexo_owner'),
    POSTGRES_WORKER_RUNTIME_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/u)
      .default('pertexo_worker'),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === 'production' &&
      value.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
    )
      context.addIssue({
        code: 'custom',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
        message: 'Production worker requires OTLP telemetry export',
      });
    if (
      value.NODE_ATTEMPT_HEARTBEAT_MILLIS >=
      value.NODE_ATTEMPT_LEASE_SECONDS * 1_000
    )
      context.addIssue({
        code: 'custom',
        path: ['NODE_ATTEMPT_HEARTBEAT_MILLIS'],
        message: 'Node-attempt heartbeat must be shorter than its lease',
      });
  })
  .transform(
    ({
      DATABASE_WORKER_URL,
      DATABASE_DISPATCHER_URL,
      DATABASE_CONNECTION_TIMEOUT_MILLIS,
      DATABASE_IDLE_TIMEOUT_MILLIS,
      DATABASE_POOL_MAX,
      DATABASE_DISPATCHER_POOL_MAX,
      REDIS_URL,
      OUTBOX_DISPATCH_BATCH_SIZE,
      OUTBOX_DISPATCH_JOB_NAMES,
      OUTBOX_DISPATCH_LEASE_MILLIS,
      OUTBOX_DISPATCH_MAX_ATTEMPTS,
      OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS,
      OUTBOX_DISPATCH_POLL_MILLIS,
      OUTBOX_DISPATCH_RETRY_MILLIS,
      WORKFLOW_COORDINATOR_MAX_ADMISSIONS,
      FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED,
      WORKFLOW_DUE_WAKEUP_BATCH_SIZE,
      WORKFLOW_DUE_WAKEUP_POLL_MILLIS,
      TRIGGER_SCHEDULE_BATCH_SIZE,
      TRIGGER_SCHEDULE_LEASE_SECONDS,
      TRIGGER_SCHEDULE_POLL_MILLIS,
      NODE_ATTEMPT_LEASE_SECONDS,
      NODE_ATTEMPT_HEARTBEAT_MILLIS,
      WORKER_INSTANCE_ID,
      NODE_ENV,
      NODE_COMPATIBILITY_COHORT,
      LOG_LEVEL,
      OTEL_EXPORTER_OTLP_ENDPOINT,
      SERVICE_VERSION,
      WORKER_MAX_EVENT_LOOP_DELAY_MILLIS,
      WORKER_MAX_RSS_BYTES,
      WORKER_RESOURCE_SAMPLE_MILLIS,
      WORKER_RESOURCE_UNHEALTHY_SAMPLES,
      POSTGRES_OWNER_USER,
      POSTGRES_WORKER_RUNTIME_USER,
    }) => ({
      nodeEnv: NODE_ENV,
      nodeCompatibilityCohort: NODE_COMPATIBILITY_COHORT,
      logLevel: LOG_LEVEL,
      observability: parseObservabilityConfig({
        serviceName: 'pertexo-worker',
        serviceVersion: SERVICE_VERSION,
        environment: NODE_ENV,
        logLevel: LOG_LEVEL,
        ...(OTEL_EXPORTER_OTLP_ENDPOINT === undefined
          ? {}
          : { otlpHttpEndpoint: OTEL_EXPORTER_OTLP_ENDPOINT }),
      }),
      resourceSafety: {
        maximumEventLoopDelayMillis: WORKER_MAX_EVENT_LOOP_DELAY_MILLIS,
        maximumRssBytes: WORKER_MAX_RSS_BYTES,
        sampleIntervalMillis: WORKER_RESOURCE_SAMPLE_MILLIS,
        unhealthySamplesBeforeDrain: WORKER_RESOURCE_UNHEALTHY_SAMPLES,
      },
      database: {
        connectionString: DATABASE_WORKER_URL,
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
        idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MILLIS,
        max: DATABASE_POOL_MAX,
        ownerRole: POSTGRES_OWNER_USER,
        workerRuntimeRole: POSTGRES_WORKER_RUNTIME_USER,
      },
      dispatcherDatabase: {
        connectionString: DATABASE_DISPATCHER_URL,
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
        idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MILLIS,
        max: DATABASE_DISPATCHER_POOL_MAX,
        ownerRole: POSTGRES_OWNER_USER,
        workerRuntimeRole: POSTGRES_WORKER_RUNTIME_USER,
      },
      outboxDispatcher: {
        batchSize: OUTBOX_DISPATCH_BATCH_SIZE,
        enabledJobNames: OUTBOX_DISPATCH_JOB_NAMES,
        leaseDurationMillis: OUTBOX_DISPATCH_LEASE_MILLIS,
        leaseOwner: `outbox:${WORKER_INSTANCE_ID}`,
        maxAttempts: OUTBOX_DISPATCH_MAX_ATTEMPTS,
        operationTimeoutMillis: OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS,
        pollIntervalMillis: OUTBOX_DISPATCH_POLL_MILLIS,
        retryDelayMillis: OUTBOX_DISPATCH_RETRY_MILLIS,
      },
      coordinator: {
        dueWakeupBatchSize: WORKFLOW_DUE_WAKEUP_BATCH_SIZE,
        dueWakeupPollIntervalMillis: WORKFLOW_DUE_WAKEUP_POLL_MILLIS,
        maximumAdmissions: WORKFLOW_COORDINATOR_MAX_ADMISSIONS,
        runTimeoutFailureContextEnabled:
          FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED,
      },
      nodeAttempt: {
        heartbeatIntervalMillis: NODE_ATTEMPT_HEARTBEAT_MILLIS,
        leaseDurationSeconds: NODE_ATTEMPT_LEASE_SECONDS,
        workerId: WORKER_INSTANCE_ID,
      },
      triggerRuntime: {
        batchSize: TRIGGER_SCHEDULE_BATCH_SIZE,
        leaseDurationSeconds: TRIGGER_SCHEDULE_LEASE_SECONDS,
        leaseOwner: `schedule:${WORKER_INSTANCE_ID}`,
        pollIntervalMillis: TRIGGER_SCHEDULE_POLL_MILLIS,
      },
      redisUrl: REDIS_URL,
    }),
  );

export type WorkerConfig = Readonly<
  z.output<typeof workerConfigSchema> & {
    artifactStore?: DualRegionArtifactStoreConfig;
    connectionEncryption?: AwsConnectionEnvelopeEncryptionConfig;
    invitationDelivery?: Readonly<{
      apiKey: string;
      fromEmail: string;
      webOrigin: string;
      timeoutMillis: number;
      tokenEncryption: Readonly<{
        current: Readonly<{ version: string; key: string }>;
        previous: readonly Readonly<{ version: string; key: string }>[];
      }>;
    }>;
    authenticationMailDelivery?: Readonly<{
      apiKey: string;
      timeoutMillis: number;
      pollIntervalMillis: number;
      workerId: string;
      encryption: Readonly<{
        current: Readonly<{ version: string; key: string }>;
        previous: readonly Readonly<{ version: string; key: string }>[];
      }>;
    }>;
  }
>;

function stringEnvironment(
  environment: Readonly<Record<string, unknown>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => {
      if (value === undefined || typeof value === 'string')
        return [name, value];
      if (typeof value === 'number' || typeof value === 'boolean')
        return [name, String(value)];
      throw new TypeError('Worker environment values must be scalar');
    }),
  );
}

function connectionEncryptionConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): AwsConnectionEnvelopeEncryptionConfig | undefined {
  const values = [
    environment.CONNECTION_KMS_KEY_REFERENCE,
    environment.CONNECTION_KMS_REGION,
    environment.CONNECTION_KMS_ENDPOINT,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  const parsed = z
    .object({
      keyReference: z.string().min(1).max(2_048),
      region: z.string().min(1).max(128),
      endpoint: z.url().optional(),
    })
    .strict()
    .parse({
      keyReference: environment.CONNECTION_KMS_KEY_REFERENCE,
      region: environment.CONNECTION_KMS_REGION,
      ...(environment.CONNECTION_KMS_ENDPOINT === undefined
        ? {}
        : { endpoint: environment.CONNECTION_KMS_ENDPOINT }),
    });
  if (
    deployed &&
    parsed.endpoint !== undefined &&
    new URL(parsed.endpoint).protocol !== 'https:'
  )
    throw new Error('HTTPS connection KMS endpoint is required when deployed');
  return Object.freeze(parsed);
}

function artifactStoreConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): DualRegionArtifactStoreConfig | undefined {
  const names = [
    'ARTIFACT_STORE_ACCESS_KEY_ID',
    'ARTIFACT_STORE_BUCKET',
    'ARTIFACT_STORE_ENDPOINT',
    'ARTIFACT_STORE_FORCE_PATH_STYLE',
    'ARTIFACT_STORE_REGION',
    'ARTIFACT_STORE_REQUEST_TIMEOUT_MS',
    'ARTIFACT_STORE_SECRET_ACCESS_KEY',
    'ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID',
    'ARTIFACT_STORE_RECOVERY_BUCKET',
    'ARTIFACT_STORE_RECOVERY_ENDPOINT',
    'ARTIFACT_STORE_RECOVERY_FORCE_PATH_STYLE',
    'ARTIFACT_STORE_RECOVERY_REGION',
    'ARTIFACT_STORE_RECOVERY_REQUEST_TIMEOUT_MS',
    'ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY',
    'ARTIFACT_MAX_BYTES',
  ] as const;
  if (names.every((name) => environment[name] === undefined)) return undefined;
  const parsed = parseDualRegionArtifactStoreConfig(environment);
  if (
    deployed &&
    [parsed.primary, parsed.recovery].some(
      (store) => new URL(store.endpoint).protocol !== 'https:',
    )
  )
    throw new Error('HTTPS artifact store endpoint is required when deployed');
  return parsed;
}

function invitationDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  enabled: boolean,
  deployed: boolean,
): WorkerConfig['invitationDelivery'] {
  const names = [
    'INVITATION_EMAIL_API_KEY',
    'INVITATION_EMAIL_FROM',
    'INVITATION_TOKEN_KEY',
    'INVITATION_TOKEN_KEY_VERSION',
    'PUBLIC_WEB_ORIGIN',
  ] as const;
  if (!enabled && names.every((name) => environment[name] === undefined))
    return undefined;
  const parsed = z
    .object({
      apiKey: z.string().min(1).max(512),
      fromEmail: z.email().max(320),
      webOrigin: z.url(),
      timeoutMillis: z.coerce
        .number()
        .int()
        .min(100)
        .max(30_000)
        .default(5_000),
      key: z.string().min(1),
      version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
      previous: z.string().optional(),
    })
    .strict()
    .parse({
      apiKey: environment.INVITATION_EMAIL_API_KEY,
      fromEmail: environment.INVITATION_EMAIL_FROM,
      webOrigin: environment.PUBLIC_WEB_ORIGIN,
      timeoutMillis: environment.INVITATION_EMAIL_TIMEOUT_MILLIS,
      key: environment.INVITATION_TOKEN_KEY,
      version: environment.INVITATION_TOKEN_KEY_VERSION,
      previous: environment.INVITATION_TOKEN_PREVIOUS_KEYS,
    });
  const url = new URL(parsed.webOrigin);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new Error('PUBLIC_WEB_ORIGIN must be an origin without a path');
  if (deployed && url.protocol !== 'https:')
    throw new Error('HTTPS public web origin is required when deployed');
  const previous = parseApplicationPreviousKeys(parsed.previous);
  return Object.freeze({
    apiKey: parsed.apiKey,
    fromEmail: parsed.fromEmail,
    webOrigin: url.origin,
    timeoutMillis: parsed.timeoutMillis,
    tokenEncryption: Object.freeze({
      current: Object.freeze({ version: parsed.version, key: parsed.key }),
      previous,
    }),
  });
}

function authenticationMailDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  enabled: boolean,
): WorkerConfig['authenticationMailDelivery'] {
  const names = [
    'AUTH_MAIL_EMAIL_API_KEY',
    'AUTH_MAIL_KEY',
    'AUTH_MAIL_KEY_VERSION',
  ] as const;
  if (!enabled && names.every((name) => environment[name] === undefined))
    return undefined;
  if (!enabled)
    throw new Error('Authentication mail delivery configuration is inactive');
  const parsed = z
    .object({
      apiKey: z.string().min(1).max(512),
      key: z.string().min(1),
      version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
      previous: z.string().optional(),
      timeoutMillis: z.coerce.number().int().min(100).max(30_000).default(5_000),
      pollIntervalMillis: z.coerce.number().int().min(100).max(60_000).default(1_000),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    })
    .strict()
    .parse({
      apiKey: environment.AUTH_MAIL_EMAIL_API_KEY,
      key: environment.AUTH_MAIL_KEY,
      version: environment.AUTH_MAIL_KEY_VERSION,
      previous: environment.AUTH_MAIL_PREVIOUS_KEYS,
      timeoutMillis: environment.AUTH_MAIL_EMAIL_TIMEOUT_MILLIS,
      pollIntervalMillis: environment.AUTH_MAIL_POLL_MILLIS,
      workerId: `auth-mail:${environment.WORKER_INSTANCE_ID ?? 'worker-local'}`,
    });
  return Object.freeze({
    apiKey: parsed.apiKey,
    timeoutMillis: parsed.timeoutMillis,
    pollIntervalMillis: parsed.pollIntervalMillis,
    workerId: parsed.workerId,
    encryption: Object.freeze({
      current: Object.freeze({ version: parsed.version, key: parsed.key }),
      previous: parseApplicationPreviousKeys(parsed.previous),
    }),
  });
}

function parseApplicationPreviousKeys(input: string | undefined) {
  if (input === undefined) return Object.freeze([]);
  return Object.freeze(
    z
      .array(
        z
          .object({
            version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
            key: z.string().min(1),
          })
          .strict(),
      )
      .max(8)
      .parse(JSON.parse(input) as unknown),
  );
}

export function parseWorkerConfig(
  environment: Readonly<Record<string, unknown>> = process.env,
): WorkerConfig {
  const result = workerConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new Error('Invalid worker configuration', { cause: result.error });
  }
  try {
    const raw = stringEnvironment(environment);
    const deployed =
      result.data.nodeEnv === 'staging' || result.data.nodeEnv === 'production';
    const connectionEncryption = connectionEncryptionConfig(raw, deployed);
    const artifactStore = artifactStoreConfig(raw, deployed);
    const invitationDelivery = invitationDeliveryConfig(
      raw,
      result.data.outboxDispatcher.enabledJobNames.includes(
        JOB_NAME.deliverWorkspaceInvitation,
      ),
      deployed,
    );
    if (deployed && raw.AUTH_MAIL_DELIVERY_ENABLED !== 'true')
      throw new Error('Deployed workers require authentication mail delivery');
    const authenticationMailDelivery = authenticationMailDeliveryConfig(
      raw,
      raw.AUTH_MAIL_DELIVERY_ENABLED === 'true',
    );
    if (
      platformServingReleaseRequiresHttpCapabilities(
        result.data.nodeCompatibilityCohort,
      ) &&
      result.data.outboxDispatcher.enabledJobNames.includes(
        JOB_NAME.executeNodeAttempt,
      ) &&
      (connectionEncryption === undefined || artifactStore === undefined)
    )
      throw new Error(
        'HTTP activation workers require connection encryption and artifact storage',
      );
    return Object.freeze({
      ...result.data,
      ...(connectionEncryption === undefined ? {} : { connectionEncryption }),
      ...(artifactStore === undefined ? {} : { artifactStore }),
      ...(invitationDelivery === undefined ? {} : { invitationDelivery }),
      ...(authenticationMailDelivery === undefined
        ? {}
        : { authenticationMailDelivery }),
      database: Object.freeze(result.data.database),
      dispatcherDatabase: Object.freeze(result.data.dispatcherDatabase),
      coordinator: Object.freeze(result.data.coordinator),
      nodeAttempt: Object.freeze(result.data.nodeAttempt),
      resourceSafety: Object.freeze(result.data.resourceSafety),
      triggerRuntime: Object.freeze(result.data.triggerRuntime),
      outboxDispatcher: Object.freeze(result.data.outboxDispatcher),
    });
  } catch (error: unknown) {
    throw new Error('Invalid worker configuration', { cause: error });
  }
}

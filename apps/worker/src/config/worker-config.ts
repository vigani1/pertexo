import { z } from 'zod';
import {
  parseArtifactStoreConfig,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import type { AwsConnectionEnvelopeEncryptionConfig } from '@pertexo/integrations/server';
import { PLATFORM_RELEASE_COHORTS } from '@pertexo/node-catalog';
import { parseObservabilityConfig } from '@pertexo/observability/config';
import { JOB_NAME, type JobName } from '@pertexo/queue';

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

export const SUPPORTED_DISPATCH_CAPABILITIES = Object.freeze([
  JOB_NAME.advanceWorkflowRun,
  JOB_NAME.executeNodeAttempt,
  JOB_NAME.executePreviewAttempt,
  JOB_NAME.expireArtifacts,
] as const satisfies readonly JobName[]);

const supportedDispatchCapabilitySet = new Set<JobName>(
  SUPPORTED_DISPATCH_CAPABILITIES,
);

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

export const workerConfigSchema = z
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
    NODE_ENV: z.enum(workerEnvironments).default('development'),
    NODE_COMPATIBILITY_COHORT: z.enum(PLATFORM_RELEASE_COHORTS).default('core'),
    LOG_LEVEL: z.enum(workerLogLevels).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
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
      NODE_ATTEMPT_LEASE_SECONDS,
      NODE_ATTEMPT_HEARTBEAT_MILLIS,
      WORKER_INSTANCE_ID,
      NODE_ENV,
      NODE_COMPATIBILITY_COHORT,
      LOG_LEVEL,
      OTEL_EXPORTER_OTLP_ENDPOINT,
      SERVICE_VERSION,
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
        maximumAdmissions: WORKFLOW_COORDINATOR_MAX_ADMISSIONS,
      },
      nodeAttempt: {
        heartbeatIntervalMillis: NODE_ATTEMPT_HEARTBEAT_MILLIS,
        leaseDurationSeconds: NODE_ATTEMPT_LEASE_SECONDS,
        workerId: WORKER_INSTANCE_ID,
      },
      redisUrl: REDIS_URL,
    }),
  );

export type WorkerConfig = Readonly<
  z.output<typeof workerConfigSchema> & {
    artifactStore?: ArtifactStoreConfig;
    connectionEncryption?: AwsConnectionEnvelopeEncryptionConfig;
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
): ArtifactStoreConfig | undefined {
  const names = [
    'ARTIFACT_STORE_ACCESS_KEY_ID',
    'ARTIFACT_STORE_BUCKET',
    'ARTIFACT_STORE_ENDPOINT',
    'ARTIFACT_STORE_FORCE_PATH_STYLE',
    'ARTIFACT_STORE_REGION',
    'ARTIFACT_STORE_REQUEST_TIMEOUT_MS',
    'ARTIFACT_STORE_SECRET_ACCESS_KEY',
    'ARTIFACT_MAX_BYTES',
  ] as const;
  if (names.every((name) => environment[name] === undefined)) return undefined;
  const parsed = parseArtifactStoreConfig(environment);
  if (deployed && new URL(parsed.endpoint).protocol !== 'https:')
    throw new Error('HTTPS artifact store endpoint is required when deployed');
  return parsed;
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
    if (
      result.data.nodeCompatibilityCohort === 'http_activation' &&
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
      database: Object.freeze(result.data.database),
      dispatcherDatabase: Object.freeze(result.data.dispatcherDatabase),
      coordinator: Object.freeze(result.data.coordinator),
      nodeAttempt: Object.freeze(result.data.nodeAttempt),
      outboxDispatcher: Object.freeze(result.data.outboxDispatcher),
    });
  } catch (error: unknown) {
    throw new Error('Invalid worker configuration', { cause: error });
  }
}

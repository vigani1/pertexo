import { z } from 'zod';
import {
  parseArtifactStoreConfig,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  parseMaintenanceDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/platform';
import type { AwsConnectionEnvelopeEncryptionConfig } from '@pertexo/integrations/server';
import { parseObservabilityConfig } from '@pertexo/observability/startup';

import {
  parseAuthenticationMailDeliveryConfig,
  type AuthenticationMailDeliveryConfig,
} from './authentication-mail.js';
import {
  parseInvitationDeliveryConfig,
  type InvitationDeliveryConfig,
} from './invitation-delivery.js';
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

const workerConfigSchema = z
  .object({
    DATABASE_URL: z.url().refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgresql:// URL',
    }),
    DATABASE_MAINTENANCE_URL: z
      .url()
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'DATABASE_MAINTENANCE_URL must be a postgresql:// URL',
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
    WORKSPACE_INBOX_FOLD_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(500),
    WORKSPACE_INBOX_FOLD_POLL_MILLIS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    // Pending run outcomes folded per database call, and the idle wait
    // between folds once nothing is pending.
    WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(500),
    WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
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
    // ADR 049: how late a `skip` schedule's occurrence may start and still run.
    TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3_600)
      .default(300),
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
    if (
      value.TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS * 1_000 <
      value.TRIGGER_SCHEDULE_POLL_MILLIS
    )
      context.addIssue({
        code: 'custom',
        path: ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS'],
        message: 'Schedule on-time window must not be shorter than its poll',
      });
  })
  .transform(
    ({
      DATABASE_URL,
      DATABASE_MAINTENANCE_URL,
      DATABASE_CONNECTION_TIMEOUT_MILLIS,
      DATABASE_IDLE_TIMEOUT_MILLIS,
      DATABASE_POOL_MAX,
      DATABASE_DISPATCHER_POOL_MAX,
      REDIS_URL,
      OUTBOX_DISPATCH_BATCH_SIZE,
      OUTBOX_DISPATCH_LEASE_MILLIS,
      OUTBOX_DISPATCH_MAX_ATTEMPTS,
      OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS,
      OUTBOX_DISPATCH_POLL_MILLIS,
      OUTBOX_DISPATCH_RETRY_MILLIS,
      WORKFLOW_COORDINATOR_MAX_ADMISSIONS,
      WORKSPACE_INBOX_FOLD_BATCH_SIZE,
      WORKSPACE_INBOX_FOLD_POLL_MILLIS,
      WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE,
      WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS,
      WORKFLOW_DUE_WAKEUP_BATCH_SIZE,
      WORKFLOW_DUE_WAKEUP_POLL_MILLIS,
      TRIGGER_SCHEDULE_BATCH_SIZE,
      TRIGGER_SCHEDULE_LEASE_SECONDS,
      TRIGGER_SCHEDULE_POLL_MILLIS,
      TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS,
      NODE_ATTEMPT_LEASE_SECONDS,
      NODE_ATTEMPT_HEARTBEAT_MILLIS,
      WORKER_INSTANCE_ID,
      NODE_ENV,
      LOG_LEVEL,
      OTEL_EXPORTER_OTLP_ENDPOINT,
      SERVICE_VERSION,
      WORKER_MAX_EVENT_LOOP_DELAY_MILLIS,
      WORKER_MAX_RSS_BYTES,
      WORKER_RESOURCE_SAMPLE_MILLIS,
      WORKER_RESOURCE_UNHEALTHY_SAMPLES,
      POSTGRES_OWNER_USER,
    }) => ({
      nodeEnv: NODE_ENV,
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
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
        idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MILLIS,
        max: DATABASE_POOL_MAX,
        ownerRole: POSTGRES_OWNER_USER,
      },
      dispatcherDatabase: {
        connectionString: DATABASE_MAINTENANCE_URL,
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
        idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MILLIS,
        max: DATABASE_DISPATCHER_POOL_MAX,
        ownerRole: POSTGRES_OWNER_USER,
      },
      outboxDispatcher: {
        batchSize: OUTBOX_DISPATCH_BATCH_SIZE,
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
      },
      workspaceInbox: {
        foldBatchSize: WORKSPACE_INBOX_FOLD_BATCH_SIZE,
        foldPollMillis: WORKSPACE_INBOX_FOLD_POLL_MILLIS,
      },
      workflowAutoPause: {
        foldBatchSize: WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE,
        foldPollMillis: WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS,
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
        onTimeWindowSeconds: TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS,
        pollIntervalMillis: TRIGGER_SCHEDULE_POLL_MILLIS,
      },
      redisUrl: REDIS_URL,
    }),
  );

export type WorkerConfig = Readonly<
  z.output<typeof workerConfigSchema> & {
    artifactStore: ArtifactStoreConfig;
    retention: RetentionConfig;
    connectionEncryption?: AwsConnectionEnvelopeEncryptionConfig;
    invitationDelivery?: InvitationDeliveryConfig;
    authenticationMailDelivery?: AuthenticationMailDeliveryConfig;
  }
>;

export type RetentionConfig = Readonly<{
  maintenanceDatabase: DatabaseConfig;
}>;

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
): ArtifactStoreConfig {
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
    const invitationDelivery = parseInvitationDeliveryConfig(raw, deployed);
    const authenticationMailDelivery = parseAuthenticationMailDeliveryConfig(
      raw,
      deployed,
    );
    if (deployed && connectionEncryption === undefined)
      throw new Error('A deployed worker requires connection encryption');
    return Object.freeze({
      ...result.data,
      ...(connectionEncryption === undefined ? {} : { connectionEncryption }),
      artifactStore,
      retention: Object.freeze({
        maintenanceDatabase: parseMaintenanceDatabaseConfig(raw),
      }),
      ...(invitationDelivery === undefined ? {} : { invitationDelivery }),
      ...(authenticationMailDelivery === undefined
        ? {}
        : { authenticationMailDelivery }),
      database: Object.freeze(result.data.database),
      dispatcherDatabase: Object.freeze(result.data.dispatcherDatabase),
      workflowAutoPause: Object.freeze(result.data.workflowAutoPause),
      coordinator: Object.freeze(result.data.coordinator),
      nodeAttempt: Object.freeze(result.data.nodeAttempt),
      resourceSafety: Object.freeze(result.data.resourceSafety),
      triggerRuntime: Object.freeze(result.data.triggerRuntime),
      workspaceInbox: Object.freeze(result.data.workspaceInbox),
      outboxDispatcher: Object.freeze(result.data.outboxDispatcher),
    });
  } catch (error: unknown) {
    throw new Error('Invalid worker configuration', { cause: error });
  }
}

import { isIP } from 'node:net';

import { z } from 'zod';
import {
  parseDualRegionArtifactStoreConfig,
  type DualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { parseObservabilityConfig } from '@pertexo/observability/config';
import type { ObservabilityConfig } from '@pertexo/observability/config';
import {
  PLATFORM_RELEASE_COHORTS,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';

import {
  identityEnvironmentShape,
  parseIdentityConfig,
  type ApiIdentityConfig,
} from './identity-config.js';

const API_NODE_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'production',
] as const;

function isProxyNetwork(value: string): boolean {
  const parts = value.split('/');
  if (parts.length > 2) return false;
  const version = isIP(parts[0] ?? '');
  if (version === 0) return false;
  const prefix = parts[1];
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/u.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

const trustedProxyCidrsSchema = z
  .string()
  .transform((value) => value.split(',').map((entry) => entry.trim()))
  .pipe(
    z
      .array(z.string().min(1).refine(isProxyNetwork, 'Invalid proxy IP/CIDR'))
      .min(1),
  );

const apiEnvironmentSchema = z
  .object({
    DATABASE_API_URL: z
      .url()
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'DATABASE_API_URL must be a postgresql:// URL',
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
    CONNECTION_KMS_ENDPOINT: z.url().optional(),
    CONNECTION_KMS_KEY_REFERENCE: z.string().min(1).max(2_048).optional(),
    CONNECTION_KMS_REGION: z.string().min(1).max(128).optional(),
    HOST: z.string().trim().min(1).default('0.0.0.0'),
    NODE_ENV: z.enum(API_NODE_ENVIRONMENTS).default('development'),
    NODE_COMPATIBILITY_COHORT: z.enum(PLATFORM_RELEASE_COHORTS).default('core'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    ...identityEnvironmentShape,
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    REDIS_URL: z
      .url()
      .refine((value) => {
        const parsed = new URL(value);
        return (
          (parsed.protocol === 'redis:' || parsed.protocol === 'rediss:') &&
          parsed.hostname.length > 0
        );
      }, 'REDIS_URL must use redis:// or rediss:// with a hostname')
      .optional(),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
    TRUST_PROXY_CIDRS: trustedProxyCidrsSchema.optional(),
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
        message: 'Production API requires OTLP telemetry export',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
      });
  });

export type ApiNodeEnvironment = (typeof API_NODE_ENVIRONMENTS)[number];

export type ApiDualRegionArtifactStoreConfig = DualRegionArtifactStoreConfig;

export type ApiConfig = Readonly<{
  artifacts?: ApiDualRegionArtifactStoreConfig;
  connections?: Readonly<{
    kmsKeyReference: string;
    region: string;
    endpoint?: string;
  }>;
  webhooks?: Readonly<{
    kmsKeyReference: string;
    region: string;
    endpoint?: string;
  }>;
  database: Readonly<{
    connectionString: string;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    max: number;
    ownerRole: string;
    workerRuntimeRole: string;
  }>;
  host: string;
  identity?: ApiIdentityConfig;
  nodeEnv: ApiNodeEnvironment;
  nodeCompatibilityCohort: PlatformReleaseCohort;
  observability: ObservabilityConfig;
  port: number;
  redisUrl: string;
  trustedProxyCidrs?: readonly string[];
}>;

export function parseApiConfig(
  environment: Record<string, string | undefined> = process.env,
): ApiConfig {
  const parsed = apiEnvironmentSchema.parse(environment);
  const observability = parseObservabilityConfig({
    serviceName: 'pertexo-api',
    serviceVersion: parsed.SERVICE_VERSION,
    environment: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : { otlpHttpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
  });
  const identity = parseIdentityConfig(parsed, environment);
  const connections = parseConnectionsConfig(parsed, environment);
  const deployed =
    parsed.NODE_ENV === 'staging' || parsed.NODE_ENV === 'production';
  if (deployed && parsed.REDIS_URL === undefined) {
    throw new Error('REDIS_URL is required when deployed');
  }
  if (deployed && parsed.TRUST_PROXY_CIDRS === undefined) {
    throw new Error('TRUST_PROXY_CIDRS is required when deployed');
  }
  const artifacts = parseArtifactsConfig(parsed.NODE_ENV, environment);

  return Object.freeze({
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(connections === undefined ? {} : { connections }),
    ...(connections === undefined ? {} : { webhooks: connections }),
    database: Object.freeze({
      connectionString: parsed.DATABASE_API_URL,
      connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
      idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
      max: parsed.DATABASE_POOL_MAX,
      ownerRole: parsed.POSTGRES_OWNER_USER,
      workerRuntimeRole: parsed.POSTGRES_WORKER_RUNTIME_USER,
    }),
    host: parsed.HOST,
    ...(identity === undefined ? {} : { identity }),
    nodeEnv: parsed.NODE_ENV,
    nodeCompatibilityCohort: parsed.NODE_COMPATIBILITY_COHORT,
    observability,
    port: parsed.PORT,
    redisUrl: parsed.REDIS_URL ?? 'redis://localhost:6379/0',
    trustedProxyCidrs: Object.freeze(parsed.TRUST_PROXY_CIDRS ?? []),
  });
}

function parseConnectionsConfig(
  environment: ParsedApiEnvironment,
  rawEnvironment: Record<string, string | undefined>,
): ApiConfig['connections'] {
  const configured = Object.entries(rawEnvironment).some(
    ([name, value]) =>
      value !== undefined && name.startsWith('CONNECTION_KMS_'),
  );
  const deployed =
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production';
  if (!configured && !deployed) return undefined;
  if (
    environment.CONNECTION_KMS_KEY_REFERENCE === undefined ||
    environment.CONNECTION_KMS_REGION === undefined
  )
    throw new Error('Connection KMS configuration is incomplete');
  if (
    deployed &&
    environment.CONNECTION_KMS_ENDPOINT !== undefined &&
    new URL(environment.CONNECTION_KMS_ENDPOINT).protocol !== 'https:'
  )
    throw new Error('HTTPS connection KMS endpoint is required when deployed');
  return Object.freeze({
    kmsKeyReference: environment.CONNECTION_KMS_KEY_REFERENCE,
    region: environment.CONNECTION_KMS_REGION,
    ...(environment.CONNECTION_KMS_ENDPOINT === undefined
      ? {}
      : { endpoint: environment.CONNECTION_KMS_ENDPOINT }),
  });
}

function parseArtifactsConfig(
  nodeEnv: ApiNodeEnvironment,
  environment: Record<string, string | undefined>,
): ApiDualRegionArtifactStoreConfig | undefined {
  const configured = Object.entries(environment).some(
    ([name, value]) =>
      value !== undefined &&
      (name.startsWith('ARTIFACT_STORE_') || name === 'ARTIFACT_MAX_BYTES'),
  );
  const deployed = nodeEnv === 'staging' || nodeEnv === 'production';
  if (!configured && !deployed) return undefined;
  try {
    return parseDualRegionArtifactStoreConfig(environment);
  } catch {
    throw new Error('Artifact store configuration is incomplete');
  }
}

type ParsedApiEnvironment = z.output<typeof apiEnvironmentSchema>;

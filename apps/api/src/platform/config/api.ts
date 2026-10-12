import { isIP } from 'node:net';
import {
  parseConnectionEncryptionConfig,
  type LocalConnectionEncryptionConfig,
} from '@pertexo/integrations/server';

import { z } from 'zod';
import {
  parseArtifactStoreConfig,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { parseObservabilityConfig } from '@pertexo/observability/startup';
import type { ObservabilityConfig } from '@pertexo/observability/startup';

import {
  identityEnvironmentShape,
  parseIdentityConfig,
  type ApiIdentityConfig,
} from './identity.js';

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

const apiEnvironmentSchema = z.object({
  DATABASE_URL: z.url().refine((value) => value.startsWith('postgresql://'), {
    message: 'DATABASE_URL must be a postgresql:// URL',
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
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  NODE_ENV: z.enum(API_NODE_ENVIRONMENTS).default('development'),
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
});

export type ApiNodeEnvironment = (typeof API_NODE_ENVIRONMENTS)[number];

export type ApiConfig = Readonly<{
  artifacts?: ArtifactStoreConfig;
  connections?:
    | LocalConnectionEncryptionConfig
    | Readonly<{
        kmsKeyReference: string;
        region: string;
        endpoint?: string;
      }>;
  webhooks?: ApiConfig['connections'];
  database: Readonly<{
    connectionString: string;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    max: number;
    ownerRole: string;
  }>;
  host: string;
  identity?: ApiIdentityConfig;
  nodeEnv: ApiNodeEnvironment;
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
      connectionString: parsed.DATABASE_URL,
      connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
      idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
      max: parsed.DATABASE_POOL_MAX,
      ownerRole: parsed.POSTGRES_OWNER_USER,
    }),
    host: parsed.HOST,
    ...(identity === undefined ? {} : { identity }),
    nodeEnv: parsed.NODE_ENV,
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
  const parsed = parseConnectionEncryptionConfig(
    rawEnvironment,
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production',
  );
  if (parsed === undefined || 'mode' in parsed) return parsed;
  return Object.freeze({
    kmsKeyReference: parsed.keyReference,
    region: parsed.region,
    ...(parsed.endpoint === undefined ? {} : { endpoint: parsed.endpoint }),
  });
}

function parseArtifactsConfig(
  nodeEnv: ApiNodeEnvironment,
  environment: Record<string, string | undefined>,
): ArtifactStoreConfig | undefined {
  const configured = Object.entries(environment).some(
    ([name, value]) =>
      value !== undefined &&
      (name.startsWith('ARTIFACT_STORE_') || name === 'ARTIFACT_MAX_BYTES'),
  );
  const deployed = nodeEnv === 'staging' || nodeEnv === 'production';
  if (!configured && !deployed) return undefined;
  try {
    return parseArtifactStoreConfig(environment);
  } catch {
    throw new Error('Artifact store configuration is incomplete');
  }
}

type ParsedApiEnvironment = z.output<typeof apiEnvironmentSchema>;

import {
  ApiConfigurationError,
  parseConfigurationSection,
} from './api-configuration.errors.js';
import {
  databaseClientEnvironmentSchema,
  clientDatabaseConfig,
  parseObservabilityConfig,
} from '@pertexo/observability/startup';
import {
  parseCallbackKeyConfig,
  type CallbackKeyConfig,
} from '@pertexo/secrets/server';
import { parseCodeSettings, type CodeSettings } from '@pertexo/node-sdk';
import {
  DEFAULT_INSTANCE_LIMITS,
  INSTANCE_LIMIT_MAXIMUMS,
} from './instance-limits.js';
import type { InstanceCapacity } from '@pertexo/database/platform';
import { isIP } from 'node:net';
import {
  parseAllowedPrivateNetworks,
  type AllowedPrivateNetwork,
} from '@pertexo/secrets/server';
import {
  parseConnectionEncryptionConfig,
  type SelfManagedConnectionEncryptionConfig,
} from '@pertexo/secrets/server';

import { z } from 'zod';
import {
  parseArtifactStoreConfig,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store/server';
import type { ObservabilityConfig } from '@pertexo/observability/startup';

import {
  identityEnvironmentShape,
  parseIdentityConfig,
  type ApiIdentityConfig,
} from './identity-config.js';

const CIDR_PARTS = 2;
// node:net's isIP answers 4 or 6.
const IPV4 = 4;
const IPV4_BITS = 32;
const IPV6_BITS = 128;
/** The API's listening port: any TCP port, 3000 when unset. */
const PORT_LIMITS = Object.freeze({ maximum: 65_535, default: 3_000 });

const API_NODE_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'production',
] as const;

function isProxyNetwork(value: string): boolean {
  const parts = value.split('/');
  // An address, optionally followed by one /prefix.
  if (parts.length > CIDR_PARTS) return false;
  const version = isIP(parts[0] ?? '');
  if (version === 0) return false;
  const prefix = parts[1];
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/u.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === IPV4 ? IPV4_BITS : IPV6_BITS);
}

const trustedProxyCidrsSchema = z
  .string()
  .transform((value) => value.split(',').map((entry) => entry.trim()))
  .pipe(
    z
      .array(z.string().min(1).refine(isProxyNetwork, 'Invalid proxy IP/CIDR'))
      .min(1),
  );

/** A whole number within what the database accepts. */
const instanceLimit = (fallback: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(fallback);

const instanceLimitsSchema = z.object({
  WORKSPACE_ACTIVE_RUN_LIMIT: instanceLimit(
    DEFAULT_INSTANCE_LIMITS.activeRunLimit,
    INSTANCE_LIMIT_MAXIMUMS.activeRunLimit,
  ),
  WORKSPACE_QUEUED_RUN_LIMIT: instanceLimit(
    DEFAULT_INSTANCE_LIMITS.queuedRunLimit,
    INSTANCE_LIMIT_MAXIMUMS.queuedRunLimit,
  ),
  WORKSPACE_FILE_LIMIT: instanceLimit(
    DEFAULT_INSTANCE_LIMITS.artifactCountLimit,
    INSTANCE_LIMIT_MAXIMUMS.artifactCountLimit,
  ),
  WEBHOOK_ENDPOINT_BURST_LIMIT: instanceLimit(
    DEFAULT_INSTANCE_LIMITS.webhookEndpointBurstLimit,
    INSTANCE_LIMIT_MAXIMUMS.webhookEndpointBurstLimit,
  ),
});

/** An operator's typo: naming the setting tells them what to fix, and it holds no secret. */
export class InvalidInstanceLimitError extends ApiConfigurationError {
  public override readonly name = 'InvalidInstanceLimitError';
  public constructor(public readonly setting: string) {
    super(
      setting,
      // session-setting-exempt: an operator-facing configuration message, not SQL
      `${setting} must be a whole number within its allowed range; set a supported integer limit.`,
    );
  }
}

function parseInstanceLimits(
  environment: Record<string, string | undefined>,
): z.output<typeof instanceLimitsSchema> {
  const parsed = instanceLimitsSchema.safeParse(environment);
  if (parsed.success) return parsed.data;
  throw new InvalidInstanceLimitError(
    String(parsed.error.issues[0]?.path[0] ?? 'instance limit'),
  );
}

const apiEnvironmentSchema = databaseClientEnvironmentSchema.extend({
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  NODE_ENV: z.enum(API_NODE_ENVIRONMENTS).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  ...identityEnvironmentShape,
  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(PORT_LIMITS.maximum)
    .default(PORT_LIMITS.default),
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
});

export type ApiNodeEnvironment = (typeof API_NODE_ENVIRONMENTS)[number];

export type ApiConfig = Readonly<{
  /** Where OAuth2 token requests may reach besides the public internet. */
  httpAllowedPrivateNetworks?: readonly AllowedPrivateNetwork[];
  smtpAllowPlaintext?: boolean;
  callbacks?: CallbackKeyConfig;
  capacity: InstanceCapacity;
  webhookEndpointBurstLimit: number;
  codeSettings: CodeSettings;
  artifacts?: ArtifactStoreConfig;
  connections?:
    | SelfManagedConnectionEncryptionConfig
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
  const limits = parseInstanceLimits(environment);
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
  // Required everywhere, as the worker requires it: a missing value used to
  // fall back to localhost outside deployed environments.
  const redisUrl = parsed.REDIS_URL;
  if (redisUrl === undefined) {
    throw new ApiConfigurationError(
      'REDIS_URL',
      'configure a Redis connection URL (redis:// or rediss://); the API needs Redis in every environment.',
    );
  }
  if (deployed && parsed.TRUST_PROXY_CIDRS === undefined) {
    throw new ApiConfigurationError(
      'TRUST_PROXY_CIDRS',
      'configure the trusted proxy IP addresses or CIDRs when deployed.',
    );
  }
  const artifacts = parseArtifactsConfig(parsed.NODE_ENV, environment);

  const callbacks = parseConfigurationSection(
    'CALLBACK_TOKEN_KEY / CALLBACK_TOKEN_KEY_VERSION / CALLBACK_TOKEN_PREVIOUS_KEYS / PUBLIC_WEB_ORIGIN',
    'configure matching callback key settings and a public web origin; use private keys with distinct versions and HTTPS when deployed.',
    () => parseCallbackKeyConfig(environment, { deployed }),
  );
  return Object.freeze({
    smtpAllowPlaintext: parseConfigurationSection(
      'SMTP_ALLOW_PLAINTEXT',
      'use true or false; defaults to false.',
      () =>
        z
          .enum(['true', 'false'])
          .default('false')
          .parse(environment.SMTP_ALLOW_PLAINTEXT) === 'true',
    ),
    httpAllowedPrivateNetworks: parseConfigurationSection(
      'HTTP_ALLOWED_PRIVATE_NETWORKS',
      'use comma-separated IPv4 or IPv6 CIDRs, or remove this setting to allow public addresses only.',
      () =>
        parseAllowedPrivateNetworks(environment.HTTP_ALLOWED_PRIVATE_NETWORKS),
    ),
    ...(callbacks === undefined ? {} : { callbacks }),
    capacity: Object.freeze({
      activeRunLimit: limits.WORKSPACE_ACTIVE_RUN_LIMIT,
      queuedRunLimit: limits.WORKSPACE_QUEUED_RUN_LIMIT,
      artifactCountLimit: limits.WORKSPACE_FILE_LIMIT,
    }),
    webhookEndpointBurstLimit: limits.WEBHOOK_ENDPOINT_BURST_LIMIT,
    codeSettings: parseCodeSettings(environment),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(connections === undefined ? {} : { connections }),
    ...(connections === undefined ? {} : { webhooks: connections }),
    database: clientDatabaseConfig(parsed),
    host: parsed.HOST,
    ...(identity === undefined ? {} : { identity }),
    nodeEnv: parsed.NODE_ENV,
    observability,
    port: parsed.PORT,
    redisUrl,
    trustedProxyCidrs: Object.freeze(parsed.TRUST_PROXY_CIDRS ?? []),
  });
}

function parseConnectionsConfig(
  environment: ParsedApiEnvironment,
  rawEnvironment: Record<string, string | undefined>,
): ApiConfig['connections'] {
  const parsed = parseConfigurationSection(
    'CONNECTION_ENCRYPTION_MODE / CONNECTION_LOCAL_KEY / CONNECTION_SELF_MANAGED_KEY / CONNECTION_SELF_MANAGED_KEY_VERSION / CONNECTION_SELF_MANAGED_PREVIOUS_KEYS / CONNECTION_KMS_KEY_REFERENCE / CONNECTION_KMS_REGION / CONNECTION_KMS_ENDPOINT',
    'select one connection encryption mode and configure its matching keys or KMS settings; use private keys with distinct versions, a KMS key reference and region for KMS, and HTTPS endpoints when deployed. Use self-managed or KMS encryption when deployed.',
    () =>
      parseConnectionEncryptionConfig(rawEnvironment, {
        deployed:
          environment.NODE_ENV === 'staging' ||
          environment.NODE_ENV === 'production',
      }),
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
  return parseArtifactStoreConfig(environment);
}

type ParsedApiEnvironment = z.output<typeof apiEnvironmentSchema>;

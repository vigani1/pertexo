import { z } from 'zod';
import { parseObservabilityConfig } from '@pertexo/observability/config';
import type { ObservabilityConfig } from '@pertexo/observability/config';
import {
  PLATFORM_RELEASE_COHORTS,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';

const API_NODE_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'production',
] as const;

const OIDC_SIGNING_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'PS256',
  'PS384',
  'PS512',
  'RS256',
  'RS384',
  'RS512',
] as const;

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
    OIDC_ALLOWED_ALGORITHMS: z.string().optional(),
    OIDC_AUTHORIZATION_ENDPOINT: z.url().optional(),
    OIDC_CLIENT_ID: z.string().trim().min(1).max(256).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).max(512).optional(),
    OIDC_ISSUER: z.url().optional(),
    OIDC_JWKS_URI: z.url().optional(),
    OIDC_REDIRECT_URI: z.url().optional(),
    OIDC_SCOPES: z.string().optional(),
    OIDC_TIMEOUT_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .max(30_000)
      .default(5_000),
    OIDC_TOKEN_ENDPOINT: z.url().optional(),
    OIDC_TRANSACTION_KEY: z.string().optional(),
    OIDC_TRANSACTION_KEY_VERSION: z.string().optional(),
    OIDC_TRANSACTION_PREVIOUS_KEYS: z.string().optional(),
    OIDC_TRANSACTION_TTL_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(5 * 60_000),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    REDIS_URL: z
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'redis:' || protocol === 'rediss:';
      }, 'REDIS_URL must use redis:// or rediss://')
      .optional(),
    SESSION_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(true),
    SESSION_TTL_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60_000),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
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

export type ApiIdentityConfig = Readonly<{
  oidc: Readonly<{
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    scopes: readonly string[];
    allowedAlgorithms: readonly (typeof OIDC_SIGNING_ALGORITHMS)[number][];
    timeoutMillis: number;
    transactionTtlMillis: number;
    allowInsecureHttpForTests: boolean;
  }>;
  secretEncryption: Readonly<{
    current: Readonly<{ version: string; key: string }>;
    previous: readonly Readonly<{ version: string; key: string }>[];
  }>;
  session: Readonly<{
    ttlMillis: number;
    secureCookie: boolean;
    sameSite: 'lax' | 'strict' | 'none';
  }>;
}>;

export type ApiConfig = Readonly<{
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
  trustedProxyHops?: number;
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
  if (deployed && parsed.TRUST_PROXY_HOPS !== 1) {
    throw new Error('TRUST_PROXY_HOPS must be 1 when deployed');
  }

  return Object.freeze({
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
    trustedProxyHops: parsed.TRUST_PROXY_HOPS,
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

type ParsedApiEnvironment = z.output<typeof apiEnvironmentSchema>;

function parseIdentityConfig(
  environment: ParsedApiEnvironment,
  rawEnvironment: Record<string, string | undefined>,
): ApiIdentityConfig | undefined {
  const required = [
    environment.OIDC_ISSUER,
    environment.OIDC_AUTHORIZATION_ENDPOINT,
    environment.OIDC_TOKEN_ENDPOINT,
    environment.OIDC_JWKS_URI,
    environment.OIDC_CLIENT_ID,
    environment.OIDC_REDIRECT_URI,
    environment.OIDC_TRANSACTION_KEY,
    environment.OIDC_TRANSACTION_KEY_VERSION,
  ];
  const configured = Object.entries(rawEnvironment).some(
    ([name, value]) =>
      value !== undefined &&
      (name.startsWith('OIDC_') || name.startsWith('SESSION_')),
  );
  const deployed =
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production';
  if (!configured && !deployed) return undefined;
  if (required.some((value) => value === undefined)) {
    throw new Error('Identity configuration is incomplete');
  }
  const issuer = requiredIdentityValue(environment.OIDC_ISSUER);
  const authorizationEndpoint = requiredIdentityValue(
    environment.OIDC_AUTHORIZATION_ENDPOINT,
  );
  const tokenEndpoint = requiredIdentityValue(environment.OIDC_TOKEN_ENDPOINT);
  const jwksUri = requiredIdentityValue(environment.OIDC_JWKS_URI);
  const clientId = requiredIdentityValue(environment.OIDC_CLIENT_ID);
  const redirectUri = requiredIdentityValue(environment.OIDC_REDIRECT_URI);
  const encryptionKey = requiredIdentityValue(environment.OIDC_TRANSACTION_KEY);
  const encryptionKeyVersion = requiredIdentityValue(
    environment.OIDC_TRANSACTION_KEY_VERSION,
  );
  if (
    deployed &&
    [issuer, authorizationEndpoint, tokenEndpoint, jwksUri, redirectUri].some(
      (value) => new URL(value).protocol !== 'https:',
    )
  ) {
    throw new Error('HTTPS identity endpoints are required when deployed');
  }
  if (deployed && !environment.SESSION_COOKIE_SECURE) {
    throw new Error('Secure session cookies are required when deployed');
  }
  if (
    environment.SESSION_COOKIE_SAME_SITE === 'none' &&
    !environment.SESSION_COOKIE_SECURE
  ) {
    throw new Error('SameSite=None requires secure session cookies');
  }

  try {
    const scopes = parseDelimitedValues(
      environment.OIDC_SCOPES ?? 'openid profile email',
      /\s+/u,
      z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u),
      16,
    );
    const allowedAlgorithms = parseDelimitedValues(
      environment.OIDC_ALLOWED_ALGORITHMS ?? 'RS256',
      /,/u,
      z.enum(OIDC_SIGNING_ALGORITHMS),
      OIDC_SIGNING_ALGORITHMS.length,
    );
    const previous = parsePreviousKeys(
      environment.OIDC_TRANSACTION_PREVIOUS_KEYS,
    );
    const identity = {
      oidc: Object.freeze({
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        jwksUri,
        clientId,
        ...(environment.OIDC_CLIENT_SECRET === undefined
          ? {}
          : { clientSecret: environment.OIDC_CLIENT_SECRET }),
        redirectUri,
        scopes,
        allowedAlgorithms,
        timeoutMillis: environment.OIDC_TIMEOUT_MILLIS,
        transactionTtlMillis: environment.OIDC_TRANSACTION_TTL_MILLIS,
        allowInsecureHttpForTests: environment.NODE_ENV === 'test',
      }),
      secretEncryption: Object.freeze({
        current: Object.freeze({
          version: encryptionKeyVersion,
          key: encryptionKey,
        }),
        previous,
      }),
      session: Object.freeze({
        ttlMillis: environment.SESSION_TTL_MILLIS,
        secureCookie: environment.SESSION_COOKIE_SECURE,
        sameSite: environment.SESSION_COOKIE_SAME_SITE,
      }),
    } satisfies ApiIdentityConfig;
    return Object.freeze(identity);
  } catch {
    // Configuration errors are deliberately sanitized because this boundary
    // parses provider credentials and encryption keys.
    throw new Error('Identity configuration is invalid');
  }
}

function requiredIdentityValue(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('Identity configuration is incomplete');
  }
  return value;
}

function parseDelimitedValues<T extends string>(
  input: string,
  delimiter: RegExp,
  schema: z.ZodType<T>,
  maximum: number,
): readonly T[] {
  const values = input
    .split(delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Object.freeze(z.array(schema).min(1).max(maximum).parse(values));
}

function parsePreviousKeys(
  input: string | undefined,
): readonly Readonly<{ version: string; key: string }>[] {
  if (input === undefined) return Object.freeze([]);
  const schema = z
    .array(
      z
        .object({
          version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
          key: z.string().min(1),
        })
        .strict(),
    )
    .max(8);
  return Object.freeze(
    schema
      .parse(JSON.parse(input) as unknown)
      .map((entry) =>
        Object.freeze({ version: entry.version, key: entry.key }),
      ),
  );
}

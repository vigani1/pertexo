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
    OIDC_ALLOWED_ALGORITHMS: z.string().optional(),
    OIDC_AUTHORIZATION_ENDPOINT: z.url().optional(),
    OIDC_CALLBACK_LANDING_PATH: z
      .string()
      .regex(/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/u)
      .default('/'),
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
    INVITATION_TOKEN_KEY: z.string().optional(),
    INVITATION_TOKEN_KEY_VERSION: z.string().optional(),
    INVITATION_TOKEN_PREVIOUS_KEYS: z.string().optional(),
    BETTER_AUTH_SECRET: z.string().min(32).max(512).optional(),
    AUTH_MAIL_MODE: z
      .enum(['local', 'durable', 'disabled'])
      .default('disabled'),
    AUTH_MAIL_FROM: z.email().max(320).optional(),
    AUTH_MAIL_KEY: z.string().optional(),
    AUTH_MAIL_KEY_VERSION: z.string().optional(),
    AUTH_MAIL_PREVIOUS_KEYS: z.string().optional(),
    AUTH_GOOGLE_CLIENT_ID: z.string().trim().min(1).max(512).optional(),
    AUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).max(1024).optional(),
    AUTH_GITHUB_CLIENT_ID: z.string().trim().min(1).max(512).optional(),
    AUTH_GITHUB_CLIENT_SECRET: z.string().min(1).max(1024).optional(),
    AUTH_MICROSOFT_CLIENT_ID: z.string().trim().min(1).max(512).optional(),
    AUTH_MICROSOFT_CLIENT_SECRET: z.string().min(1).max(1024).optional(),
    AUTH_MICROSOFT_TENANT_ID: z.string().trim().min(1).max(512).optional(),
    AUTH_APPLE_CLIENT_ID: z.string().trim().min(1).max(512).optional(),
    AUTH_APPLE_CLIENT_SECRET: z.string().min(1).max(4096).optional(),
    OIDC_TRANSACTION_TTL_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(5 * 60_000),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PUBLIC_WEB_ORIGIN: z.url().optional(),
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
    SESSION_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    SESSION_TTL_MILLIS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60_000),
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

export type ApiIdentityConfig = Readonly<{
  publicWebOrigin?: string;
  oidc?: Readonly<{
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    clientId: string;
    clientSecret?: string;
    callbackLandingPath?: string;
    redirectUri: string;
    scopes: readonly string[];
    allowedAlgorithms: readonly (typeof OIDC_SIGNING_ALGORITHMS)[number][];
    timeoutMillis: number;
    transactionTtlMillis: number;
    allowInsecureHttpForTests: boolean;
  }>;
  secretEncryption?: Readonly<{
    current: Readonly<{ version: string; key: string }>;
    previous: readonly Readonly<{ version: string; key: string }>[];
  }>;
  invitationTokenEncryption?: Readonly<{
    current: Readonly<{ version: string; key: string }>;
    previous: readonly Readonly<{ version: string; key: string }>[];
  }>;
  session: Readonly<{
    ttlMillis: number;
    secureCookie: boolean;
    sameSite: 'lax' | 'strict' | 'none';
  }>;
  betterAuth?: Readonly<{
    secret: string;
    mailMode: 'local' | 'durable' | 'disabled';
    durableMail?: Readonly<{
      fromEmail: string;
      encryption: Readonly<{
        current: Readonly<{ version: string; key: string }>;
        previous: readonly Readonly<{ version: string; key: string }>[];
      }>;
    }>;
    providers: Readonly<{
      google?: Readonly<{ clientId: string; clientSecret: string }>;
      github?: Readonly<{ clientId: string; clientSecret: string }>;
      microsoft?: Readonly<{
        clientId: string;
        clientSecret: string;
        tenantId?: string;
      }>;
      apple?: Readonly<{ clientId: string; clientSecret: string }>;
    }>;
  }>;
}>;

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

function parseIdentityConfig(
  environment: ParsedApiEnvironment,
  rawEnvironment: Record<string, string | undefined>,
): ApiIdentityConfig | undefined {
  const oidcValues = [
    environment.OIDC_ISSUER,
    environment.OIDC_AUTHORIZATION_ENDPOINT,
    environment.OIDC_TOKEN_ENDPOINT,
    environment.OIDC_JWKS_URI,
    environment.OIDC_CLIENT_ID,
    environment.OIDC_REDIRECT_URI,
    environment.OIDC_TRANSACTION_KEY,
    environment.OIDC_TRANSACTION_KEY_VERSION,
  ];
  const oidcConfigured = Object.entries(rawEnvironment).some(
    ([name, value]) => value !== undefined && name.startsWith('OIDC_'),
  );
  const configured = Object.entries(rawEnvironment).some(
    ([name, value]) =>
      value !== undefined &&
      (name.startsWith('OIDC_') ||
        name.startsWith('SESSION_') ||
        name.startsWith('AUTH_') ||
        name === 'BETTER_AUTH_SECRET' ||
        name === 'PUBLIC_WEB_ORIGIN' ||
        name.startsWith('INVITATION_TOKEN_')),
  );
  const deployed =
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production';
  if (!configured && !deployed) return undefined;
  if (oidcConfigured && oidcValues.some((value) => value === undefined)) {
    throw new Error('Identity configuration is incomplete');
  }
  if (!oidcConfigured && environment.BETTER_AUTH_SECRET === undefined)
    throw new Error('Better Auth configuration is incomplete');
  const invitationKey = environment.INVITATION_TOKEN_KEY;
  const invitationKeyVersion = environment.INVITATION_TOKEN_KEY_VERSION;
  if (
    deployed &&
    (invitationKey === undefined || invitationKeyVersion === undefined)
  )
    throw new Error('Invitation token encryption configuration is incomplete');
  if ((invitationKey === undefined) !== (invitationKeyVersion === undefined))
    throw new Error('Invitation token encryption configuration is incomplete');
  let oidc: ReturnType<typeof parseOidcConfig> | undefined;
  try {
    oidc = oidcConfigured ? parseOidcConfig(environment, deployed) : undefined;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message === 'HTTPS identity endpoints are required when deployed'
    )
      throw error;
    throw new Error('Identity configuration is invalid');
  }
  const publicWebOrigin =
    environment.PUBLIC_WEB_ORIGIN === undefined
      ? oidc === undefined
        ? undefined
        : new URL(oidc.oidc.redirectUri).origin
      : normalizedOrigin(environment.PUBLIC_WEB_ORIGIN);
  if (
    environment.BETTER_AUTH_SECRET !== undefined &&
    publicWebOrigin === undefined
  )
    throw new Error('PUBLIC_WEB_ORIGIN is required for Better Auth');
  if (deployed && publicWebOrigin === undefined)
    throw new Error('PUBLIC_WEB_ORIGIN is required when deployed');
  const publicWebProtocol =
    publicWebOrigin === undefined
      ? undefined
      : new URL(publicWebOrigin).protocol;
  const secureCookie =
    environment.SESSION_COOKIE_SECURE ?? publicWebProtocol === 'https:';
  if (
    deployed &&
    publicWebOrigin !== undefined &&
    publicWebProtocol !== 'https:'
  )
    throw new Error('HTTPS public web origin is required when deployed');
  if (publicWebProtocol === 'http:' && secureCookie) {
    throw new Error(
      'Secure session cookies require an HTTPS public web origin',
    );
  }
  if (deployed && !secureCookie) {
    throw new Error('Secure session cookies are required when deployed');
  }
  if (deployed && environment.BETTER_AUTH_SECRET === undefined)
    throw new Error('Better Auth configuration is incomplete');
  if (deployed && environment.AUTH_MAIL_MODE !== 'durable')
    throw new Error('Durable authentication mail is required when deployed');
  if (environment.SESSION_COOKIE_SAME_SITE === 'none' && !secureCookie) {
    throw new Error('SameSite=None requires secure session cookies');
  }

  try {
    const providers = parseAuthenticationProviders(environment);
    const durableMail = parseDurableAuthenticationMail(environment);
    const identity = {
      ...(publicWebOrigin === undefined ? {} : { publicWebOrigin }),
      ...(oidc ?? {}),
      ...(invitationKey === undefined || invitationKeyVersion === undefined
        ? {}
        : {
            invitationTokenEncryption: Object.freeze({
              current: Object.freeze({
                version: invitationKeyVersion,
                key: invitationKey,
              }),
              previous: parsePreviousKeys(
                environment.INVITATION_TOKEN_PREVIOUS_KEYS,
              ),
            }),
          }),
      session: Object.freeze({
        ttlMillis: environment.SESSION_TTL_MILLIS,
        secureCookie,
        sameSite: environment.SESSION_COOKIE_SAME_SITE,
      }),
      ...(environment.BETTER_AUTH_SECRET === undefined
        ? {}
        : {
            betterAuth: Object.freeze({
              secret: environment.BETTER_AUTH_SECRET,
              mailMode: environment.AUTH_MAIL_MODE,
              ...(durableMail === undefined ? {} : { durableMail }),
              providers,
            }),
          }),
    } satisfies ApiIdentityConfig;
    return Object.freeze(identity);
  } catch {
    // Configuration errors are deliberately sanitized because this boundary
    // parses provider credentials and encryption keys.
    throw new Error('Identity configuration is invalid');
  }
}

function parseDurableAuthenticationMail(
  environment: ParsedApiEnvironment,
): NonNullable<ApiIdentityConfig['betterAuth']>['durableMail'] {
  const values = [
    environment.AUTH_MAIL_FROM,
    environment.AUTH_MAIL_KEY,
    environment.AUTH_MAIL_KEY_VERSION,
  ];
  if (environment.AUTH_MAIL_MODE !== 'durable') {
    if (values.some((value) => value !== undefined))
      throw new Error('Durable authentication mail configuration is inactive');
    return undefined;
  }
  if (values.some((value) => value === undefined))
    throw new Error('Durable authentication mail configuration is incomplete');
  return Object.freeze({
    fromEmail: requiredIdentityValue(environment.AUTH_MAIL_FROM),
    encryption: Object.freeze({
      current: Object.freeze({
        key: requiredIdentityValue(environment.AUTH_MAIL_KEY),
        version: requiredIdentityValue(environment.AUTH_MAIL_KEY_VERSION),
      }),
      previous: parsePreviousKeys(environment.AUTH_MAIL_PREVIOUS_KEYS),
    }),
  });
}

function parseOidcConfig(
  environment: ParsedApiEnvironment,
  deployed: boolean,
): Readonly<{
  oidc: NonNullable<ApiIdentityConfig['oidc']>;
  secretEncryption: NonNullable<ApiIdentityConfig['secretEncryption']>;
}> {
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
  )
    throw new Error('HTTPS identity endpoints are required when deployed');
  return Object.freeze({
    oidc: Object.freeze({
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      clientId,
      callbackLandingPath: environment.OIDC_CALLBACK_LANDING_PATH,
      ...(environment.OIDC_CLIENT_SECRET === undefined
        ? {}
        : { clientSecret: environment.OIDC_CLIENT_SECRET }),
      redirectUri,
      scopes: parseDelimitedValues(
        environment.OIDC_SCOPES ?? 'openid profile email',
        /\s+/u,
        z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u),
        16,
      ),
      allowedAlgorithms: parseDelimitedValues(
        environment.OIDC_ALLOWED_ALGORITHMS ?? 'RS256',
        /,/u,
        z.enum(OIDC_SIGNING_ALGORITHMS),
        OIDC_SIGNING_ALGORITHMS.length,
      ),
      timeoutMillis: environment.OIDC_TIMEOUT_MILLIS,
      transactionTtlMillis: environment.OIDC_TRANSACTION_TTL_MILLIS,
      allowInsecureHttpForTests: environment.NODE_ENV === 'test',
    }),
    secretEncryption: Object.freeze({
      current: Object.freeze({
        version: encryptionKeyVersion,
        key: encryptionKey,
      }),
      previous: parsePreviousKeys(environment.OIDC_TRANSACTION_PREVIOUS_KEYS),
    }),
  });
}

function parseAuthenticationProviders(
  environment: ParsedApiEnvironment,
): NonNullable<ApiIdentityConfig['betterAuth']>['providers'] {
  const google = authenticationProviderPair(
    'Google',
    environment.AUTH_GOOGLE_CLIENT_ID,
    environment.AUTH_GOOGLE_CLIENT_SECRET,
  );
  const github = authenticationProviderPair(
    'GitHub',
    environment.AUTH_GITHUB_CLIENT_ID,
    environment.AUTH_GITHUB_CLIENT_SECRET,
  );
  const microsoft = authenticationProviderPair(
    'Microsoft',
    environment.AUTH_MICROSOFT_CLIENT_ID,
    environment.AUTH_MICROSOFT_CLIENT_SECRET,
  );
  const apple = authenticationProviderPair(
    'Apple',
    environment.AUTH_APPLE_CLIENT_ID,
    environment.AUTH_APPLE_CLIENT_SECRET,
  );
  return Object.freeze({
    ...(google === undefined ? {} : { google }),
    ...(github === undefined ? {} : { github }),
    ...(microsoft === undefined
      ? {}
      : {
          microsoft: Object.freeze({
            ...microsoft,
            ...(environment.AUTH_MICROSOFT_TENANT_ID === undefined
              ? {}
              : { tenantId: environment.AUTH_MICROSOFT_TENANT_ID }),
          }),
        }),
    ...(apple === undefined ? {} : { apple }),
  });
}

function authenticationProviderPair(
  provider: string,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Readonly<{ clientId: string; clientSecret: string }> | undefined {
  if (clientId === undefined && clientSecret === undefined) return undefined;
  if (clientId === undefined || clientSecret === undefined)
    throw new Error(`${provider} authentication configuration is incomplete`);
  return Object.freeze({ clientId, clientSecret });
}

function normalizedOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.origin === 'null' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error('PUBLIC_WEB_ORIGIN must be an origin without a path');
  return parsed.origin;
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

import { z } from 'zod';

import {
  parseAuthenticationProviders,
  parseDurableAuthenticationMail,
  parseOidcConfig,
  parsePreviousKeys,
  type OIDC_SIGNING_ALGORITHMS,
} from './identity-credentials-config.js';

/** Environment variables owned by browser identity and authentication. */
export const identityEnvironmentShape = {
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
  AUTH_MAIL_MODE: z.enum(['local', 'durable', 'disabled']).default('disabled'),
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
  PUBLIC_WEB_ORIGIN: z.url().optional(),
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
} satisfies z.ZodRawShape;

export type IdentityEnvironment = z.output<
  z.ZodObject<typeof identityEnvironmentShape>
> &
  Readonly<{ NODE_ENV: 'development' | 'test' | 'staging' | 'production' }>;

type EncryptionKeys = Readonly<{
  current: Readonly<{ version: string; key: string }>;
  previous: readonly Readonly<{ version: string; key: string }>[];
}>;

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
  secretEncryption?: EncryptionKeys;
  invitationTokenEncryption?: EncryptionKeys;
  session: Readonly<{
    ttlMillis: number;
    secureCookie: boolean;
    sameSite: 'lax' | 'strict' | 'none';
  }>;
  betterAuth?: Readonly<{
    secret: string;
    mailMode: 'local' | 'durable' | 'disabled';
    durableMail?: Readonly<{ fromEmail: string; encryption: EncryptionKeys }>;
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

export type LegacyOidcConfig = Readonly<{
  oidc: NonNullable<ApiIdentityConfig['oidc']>;
  secretEncryption: EncryptionKeys;
}>;

type IdentityScope = Readonly<{
  configured: boolean;
  oidcConfigured: boolean;
  deployed: boolean;
}>;

/**
 * Parses browser identity: legacy OIDC, Better Auth, authentication mail,
 * invitation keys and the browser session boundary. Checks run in a fixed
 * order so the first violated deployment rule is the reported one, and
 * failures that could echo credentials or keys are sanitized.
 */
export function parseIdentityConfig(
  environment: IdentityEnvironment,
  rawEnvironment: Record<string, string | undefined>,
): ApiIdentityConfig | undefined {
  const scope = identityScope(environment, rawEnvironment);
  if (!scope.configured && !scope.deployed) return undefined;
  requireAuthenticationAuthority(environment, scope.oidcConfigured);
  requireInvitationKeyPair(environment, scope.deployed);
  const legacyOidc = scope.oidcConfigured
    ? parseLegacyOidc(environment, scope.deployed)
    : undefined;
  const publicWebOrigin = resolvePublicWebOrigin(
    environment,
    legacyOidc,
    scope.deployed,
  );
  const session = parseSessionPolicy(
    environment,
    publicWebOrigin,
    scope.deployed,
  );
  requireDeployedBetterAuth(environment, scope.deployed);
  try {
    return Object.freeze({
      ...(publicWebOrigin === undefined ? {} : { publicWebOrigin }),
      ...(legacyOidc ?? {}),
      ...invitationTokenEncryption(environment),
      session,
      ...betterAuthConfig(environment),
    } satisfies ApiIdentityConfig);
  } catch {
    // Configuration errors are deliberately sanitized because this boundary
    // parses provider credentials and encryption keys.
    throw new Error('Identity configuration is invalid');
  }
}

function identityScope(
  environment: IdentityEnvironment,
  rawEnvironment: Record<string, string | undefined>,
): IdentityScope {
  const present = Object.entries(rawEnvironment).flatMap(([name, value]) =>
    value === undefined ? [] : [name],
  );
  return {
    configured: present.some(
      (name) =>
        name.startsWith('OIDC_') ||
        name.startsWith('SESSION_') ||
        name.startsWith('AUTH_') ||
        name === 'BETTER_AUTH_SECRET' ||
        name === 'PUBLIC_WEB_ORIGIN' ||
        name.startsWith('INVITATION_TOKEN_'),
    ),
    oidcConfigured: present.some((name) => name.startsWith('OIDC_')),
    deployed:
      environment.NODE_ENV === 'staging' ||
      environment.NODE_ENV === 'production',
  };
}

/** Legacy OIDC must be complete when present; otherwise Better Auth is required. */
function requireAuthenticationAuthority(
  environment: IdentityEnvironment,
  oidcConfigured: boolean,
): void {
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
  if (oidcConfigured && oidcValues.some((value) => value === undefined))
    throw new Error('Identity configuration is incomplete');
  if (!oidcConfigured && environment.BETTER_AUTH_SECRET === undefined)
    throw new Error('Better Auth configuration is incomplete');
}

function requireInvitationKeyPair(
  environment: IdentityEnvironment,
  deployed: boolean,
): void {
  const keyMissing = environment.INVITATION_TOKEN_KEY === undefined;
  const versionMissing = environment.INVITATION_TOKEN_KEY_VERSION === undefined;
  if (
    (deployed && (keyMissing || versionMissing)) ||
    keyMissing !== versionMissing
  )
    throw new Error('Invitation token encryption configuration is incomplete');
}

function parseLegacyOidc(
  environment: IdentityEnvironment,
  deployed: boolean,
): LegacyOidcConfig {
  try {
    return parseOidcConfig(environment, deployed);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message === 'HTTPS identity endpoints are required when deployed'
    )
      throw error;
    throw new Error('Identity configuration is invalid');
  }
}

/** The browser origin is explicit, or the legacy OIDC redirect's origin. */
function resolvePublicWebOrigin(
  environment: IdentityEnvironment,
  legacyOidc: LegacyOidcConfig | undefined,
  deployed: boolean,
): string | undefined {
  const legacyOrigin =
    legacyOidc === undefined
      ? undefined
      : new URL(legacyOidc.oidc.redirectUri).origin;
  const origin =
    environment.PUBLIC_WEB_ORIGIN === undefined
      ? legacyOrigin
      : normalizedOrigin(environment.PUBLIC_WEB_ORIGIN);
  if (environment.BETTER_AUTH_SECRET !== undefined && origin === undefined)
    throw new Error('PUBLIC_WEB_ORIGIN is required for Better Auth');
  if (deployed && origin === undefined)
    throw new Error('PUBLIC_WEB_ORIGIN is required when deployed');
  if (deployed && origin !== undefined && new URL(origin).protocol !== 'https:')
    throw new Error('HTTPS public web origin is required when deployed');
  return origin;
}

/** Cookies default to Secure on an HTTPS origin and must be Secure when deployed. */
function parseSessionPolicy(
  environment: IdentityEnvironment,
  publicWebOrigin: string | undefined,
  deployed: boolean,
): ApiIdentityConfig['session'] {
  const protocol =
    publicWebOrigin === undefined
      ? undefined
      : new URL(publicWebOrigin).protocol;
  const secureCookie =
    environment.SESSION_COOKIE_SECURE ?? protocol === 'https:';
  if (protocol === 'http:' && secureCookie)
    throw new Error(
      'Secure session cookies require an HTTPS public web origin',
    );
  if (deployed && !secureCookie)
    throw new Error('Secure session cookies are required when deployed');
  if (environment.SESSION_COOKIE_SAME_SITE === 'none' && !secureCookie)
    throw new Error('SameSite=None requires secure session cookies');
  return Object.freeze({
    ttlMillis: environment.SESSION_TTL_MILLIS,
    secureCookie,
    sameSite: environment.SESSION_COOKIE_SAME_SITE,
  });
}

function requireDeployedBetterAuth(
  environment: IdentityEnvironment,
  deployed: boolean,
): void {
  if (deployed && environment.BETTER_AUTH_SECRET === undefined)
    throw new Error('Better Auth configuration is incomplete');
  if (deployed && environment.AUTH_MAIL_MODE !== 'durable')
    throw new Error('Durable authentication mail is required when deployed');
}

function invitationTokenEncryption(
  environment: IdentityEnvironment,
): Pick<ApiIdentityConfig, 'invitationTokenEncryption'> {
  const key = environment.INVITATION_TOKEN_KEY;
  const version = environment.INVITATION_TOKEN_KEY_VERSION;
  if (key === undefined || version === undefined) return {};
  return {
    invitationTokenEncryption: Object.freeze({
      current: Object.freeze({ version, key }),
      previous: parsePreviousKeys(environment.INVITATION_TOKEN_PREVIOUS_KEYS),
    }),
  };
}

function betterAuthConfig(
  environment: IdentityEnvironment,
): Pick<ApiIdentityConfig, 'betterAuth'> {
  const providers = parseAuthenticationProviders(environment);
  const durableMail = parseDurableAuthenticationMail(environment);
  if (environment.BETTER_AUTH_SECRET === undefined) return {};
  return {
    betterAuth: Object.freeze({
      secret: environment.BETTER_AUTH_SECRET,
      mailMode: environment.AUTH_MAIL_MODE,
      ...(durableMail === undefined ? {} : { durableMail }),
      providers,
    }),
  };
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

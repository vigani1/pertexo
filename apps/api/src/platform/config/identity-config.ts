import { z } from 'zod';

import {
  parseAuthenticationProviders,
  parseDurableAuthenticationMail,
  parsePreviousKeys,
} from './identity-credentials-config.js';

/** Environment variables owned by browser identity and authentication. */
export const identityEnvironmentShape = {
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
  publicWebOrigin: string;
  invitationTokenEncryption?: EncryptionKeys;
  session: Readonly<{
    ttlMillis: number;
    secureCookie: boolean;
    sameSite: 'lax' | 'strict' | 'none';
  }>;
  betterAuth: Readonly<{
    secret: string;
    mailMode: 'local' | 'durable' | 'disabled';
    /** Local development prints each local message's link to stdout. */
    printLocalMailLinks?: true;
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

type IdentityScope = Readonly<{
  configured: boolean;
  deployed: boolean;
}>;

/**
 * Parses browser identity: Better Auth, authentication mail, invitation keys
 * and the browser session boundary. Checks run in a fixed order so the first
 * violated deployment rule is the reported one, and failures that could echo
 * credentials or keys are sanitized.
 */
export function parseIdentityConfig(
  environment: IdentityEnvironment,
  rawEnvironment: Record<string, string | undefined>,
): ApiIdentityConfig | undefined {
  const scope = identityScope(environment, rawEnvironment);
  if (!scope.configured && !scope.deployed) return undefined;
  const secret = environment.BETTER_AUTH_SECRET;
  if (secret === undefined)
    throw new Error('Better Auth configuration is incomplete');
  requireInvitationKeyPair(environment, scope.deployed);
  const publicWebOrigin = parsePublicWebOrigin(environment, scope.deployed);
  const session = parseSessionPolicy(
    environment,
    publicWebOrigin,
    scope.deployed,
  );
  if (scope.deployed && environment.AUTH_MAIL_MODE !== 'durable')
    throw new Error('Durable authentication mail is required when deployed');
  try {
    return Object.freeze({
      publicWebOrigin,
      ...invitationTokenEncryption(environment),
      session,
      betterAuth: betterAuthConfig(environment, secret),
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
        name.startsWith('SESSION_') ||
        name.startsWith('AUTH_') ||
        name === 'BETTER_AUTH_SECRET' ||
        name === 'PUBLIC_WEB_ORIGIN' ||
        name.startsWith('INVITATION_TOKEN_'),
    ),
    deployed:
      environment.NODE_ENV === 'staging' ||
      environment.NODE_ENV === 'production',
  };
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

/** The browser origin is required and must be HTTPS when deployed. */
function parsePublicWebOrigin(
  environment: IdentityEnvironment,
  deployed: boolean,
): string {
  if (environment.PUBLIC_WEB_ORIGIN === undefined)
    throw new Error('PUBLIC_WEB_ORIGIN is required for Better Auth');
  const origin = normalizedOrigin(environment.PUBLIC_WEB_ORIGIN);
  if (deployed && new URL(origin).protocol !== 'https:')
    throw new Error('HTTPS public web origin is required when deployed');
  return origin;
}

/** Cookies default to Secure on an HTTPS origin and must be Secure when deployed. */
function parseSessionPolicy(
  environment: IdentityEnvironment,
  publicWebOrigin: string,
  deployed: boolean,
): ApiIdentityConfig['session'] {
  const protocol = new URL(publicWebOrigin).protocol;
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
  secret: string,
): ApiIdentityConfig['betterAuth'] {
  const durableMail = parseDurableAuthenticationMail(environment);
  // Local mail reaches a developer only as printed links; staging and
  // production require durable mail, and tests read the sink directly.
  const printLocalMailLinks =
    environment.AUTH_MAIL_MODE === 'local' &&
    environment.NODE_ENV === 'development';
  return Object.freeze({
    secret,
    mailMode: environment.AUTH_MAIL_MODE,
    ...(printLocalMailLinks ? { printLocalMailLinks } : {}),
    ...(durableMail === undefined ? {} : { durableMail }),
    providers: parseAuthenticationProviders(environment),
  });
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

import { z } from 'zod';

import type {
  ApiIdentityConfig,
  IdentityEnvironment,
  LegacyOidcConfig,
} from './identity-config.js';

/*
 * Parsers for the credential- and key-bearing identity sections. Their errors
 * can describe secret values, so parseIdentityConfig sanitizes every failure
 * except the explicit deployment rule for HTTPS identity endpoints.
 */

export const OIDC_SIGNING_ALGORITHMS = [
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

export function parseDurableAuthenticationMail(
  environment: IdentityEnvironment,
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

export function parseOidcConfig(
  environment: IdentityEnvironment,
  deployed: boolean,
): LegacyOidcConfig {
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

export function parseAuthenticationProviders(
  environment: IdentityEnvironment,
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

export function parsePreviousKeys(
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

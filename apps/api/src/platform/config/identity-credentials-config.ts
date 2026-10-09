import { z } from 'zod';

import type {
  ApiIdentityConfig,
  IdentityEnvironment,
} from './identity-config.js';

/*
 * Parsers for the credential- and key-bearing identity sections. Their errors
 * can describe secret values, so parseIdentityConfig sanitizes every failure.
 */

export function parseDurableAuthenticationMail(
  environment: IdentityEnvironment,
): ApiIdentityConfig['betterAuth']['durableMail'] {
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

export function parseAuthenticationProviders(
  environment: IdentityEnvironment,
): ApiIdentityConfig['betterAuth']['providers'] {
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

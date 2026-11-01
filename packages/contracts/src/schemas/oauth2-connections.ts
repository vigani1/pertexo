import { z } from 'zod';

import { connectionResponseFields } from './connection-fields.js';
import { utf8ByteLength } from './shared/text.js';

/** A provider returns the browser here, so this is what people register with it. */
export const OAUTH2_CALLBACK_PATH = '/v1/connections/oauth2/callback';
/** The web page that callback redirects to, in the tab consent opened. */
export const OAUTH2_LANDING_PATH = '/connections/oauth2/finished';

const printable = /^[\x20-\x7e]+$/u;

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * The shape of an address only. Whether http or a private host may be used
 * depends on the operator's allowed networks, so the API decides that once.
 */
function endpointUrlSchema(reservedParameters: readonly string[]) {
  return z
    .url()
    .max(2_048)
    .refine((value) => utf8ByteLength(value) <= 2_048, 'URL exceeds byte limit')
    .refine((value) => {
      const url = parseUrl(value);
      return (
        url !== undefined &&
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username === '' &&
        url.password === '' &&
        url.hash === '' &&
        !value.includes('#')
      );
    }, 'Use a web address without credentials or a fragment')
    .refine((value) => {
      const url = parseUrl(value);
      return (
        url === undefined ||
        !reservedParameters.some((name) => url.searchParams.has(name))
      );
    }, 'Pertexo sets this query parameter itself');
}

const AUTHORIZATION_RESERVED_PARAMETERS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;
const TOKEN_RESERVED_PARAMETERS = [
  'grant_type',
  'code',
  'redirect_uri',
  'client_id',
  'client_secret',
  'refresh_token',
  'code_verifier',
  'scope',
] as const;

/** Extra provider parameters, such as Google's access_type or Auth0's audience. */
function extraParametersSchema(reservedParameters: readonly string[]) {
  return z
    .record(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_.~-]+$/u),
      z.string().max(1_024).regex(printable),
    )
    .refine((parameters) => Object.keys(parameters).length <= 16, {
      message: 'at most 16 extra parameters are allowed',
    })
    .refine(
      (parameters) =>
        !Object.keys(parameters).some((name) =>
          reservedParameters.includes(name.toLowerCase()),
        ),
      { message: 'Pertexo sets this parameter itself' },
    );
}

const requestHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u,
  );

/** Where HTTP Request may send this connection's token. */
const oauth2RequestHostsSchema = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('any') })
    .strict()
    .readonly(),
  z
    .object({
      mode: z.literal('listed'),
      hosts: z
        .array(requestHostSchema)
        .min(1)
        .max(32)
        .refine((hosts) => new Set(hosts).size === hosts.length, {
          message: 'hosts must be unique',
        }),
    })
    .strict()
    .readonly(),
]);

const sharedClientSettings = {
  tokenUrl: endpointUrlSchema(TOKEN_RESERVED_PARAMETERS),
  clientId: z.string().trim().min(1).max(512).regex(printable),
  /** Sent as typed: some services separate scopes with commas, not spaces. */
  scope: z
    .string()
    .trim()
    .max(2_048)
    .regex(/^[\x20-\x7e]*$/u),
  clientAuthentication: z.enum(['basic', 'body']),
  tokenParameters: extraParametersSchema(TOKEN_RESERVED_PARAMETERS),
  requestHosts: oauth2RequestHostsSchema,
} as const;

/** Everything but the client secret: shown to readers and stored as one format. */
export const oauth2ClientSettingsSchema = z.discriminatedUnion('grantType', [
  z
    .object({
      grantType: z.literal('authorization_code'),
      authorizationUrl: endpointUrlSchema(AUTHORIZATION_RESERVED_PARAMETERS),
      authorizationParameters: extraParametersSchema(
        AUTHORIZATION_RESERVED_PARAMETERS,
      ),
      pkce: z.enum(['s256', 'none']),
      ...sharedClientSettings,
    })
    .strict()
    .readonly(),
  z
    .object({
      grantType: z.literal('client_credentials'),
      ...sharedClientSettings,
    })
    .strict()
    .readonly(),
]);

/** Sent in full on create and replace: changing an address needs the secret again. */
export const oauth2CredentialSchema = z
  .object({
    type: z.literal('oauth2'),
    settings: oauth2ClientSettingsSchema,
    clientSecret: z.string().trim().min(1).max(1_024).regex(printable),
  })
  .strict()
  .readonly();

const oauth2ConnectionFields = {
  ...connectionResponseFields,
  providerKey: z.literal('http'),
  authType: z.literal('oauth2'),
  oauth2: z
    .object({
      settings: oauth2ClientSettingsSchema,
      /** What to register with the provider. */
      redirectUri: z.url().max(2_048),
    })
    .strict()
    .readonly(),
} as const;

/** A connection has a grant exactly when it is active, so neither can disagree. */
export const oauth2ConnectionResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...oauth2ConnectionFields,
      status: z.literal('active'),
      grant: z
        .object({
          authorizedAt: z.iso.datetime(),
          /** Null when the service gave no lifetime. */
          accessTokenExpiresAt: z.iso.datetime().nullable(),
          /** False when Pertexo can't renew it, so someone must reconnect. */
          renewable: z.boolean(),
        })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...oauth2ConnectionFields,
      status: z.enum(['reauthorization_required', 'revoked']),
    })
    .strict()
    .readonly(),
]);

/** Why an OAuth2 connection isn't active; the service's own words are never kept. */
export const oauth2ConnectionErrorCodeSchema = z.enum([
  'connection.oauth2_not_authorized',
  'connection.oauth2_grant_revoked',
  'connection.oauth2_client_rejected',
  'connection.oauth2_token_expired',
]);

/** What a person sees on an HTTP Request step that couldn't get a token. */
export const oauth2StepFailureCodeSchema = z.enum([
  'http.oauth2_not_connected',
  'http.oauth2_connection_revoked',
  'http.oauth2_grant_revoked',
  'http.oauth2_client_rejected',
  'http.oauth2_token_expired',
  'http.oauth2_token_rate_limited',
  'http.oauth2_token_endpoint_unavailable',
  'http.oauth2_token_response_invalid',
  'http.oauth2_token_address_blocked',
  'http.oauth2_refresh_busy',
  'http.oauth2_host_not_allowed',
]);

export const oauth2AuthorizationStartResponseSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('consent'),
        authorizationUrl: z.url().max(32_768),
        expiresAt: z.iso.datetime(),
      })
      .strict()
      .readonly(),
    z
      .object({
        kind: z.literal('connected'),
        connection: oauth2ConnectionResponseSchema,
      })
      .strict()
      .readonly(),
  ],
);

/** The workspace, base64url, then 256 random bits: row security needs the first. */
export const oauth2CallbackStateSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);
export const oauth2CallbackCodeSchema = z.string().min(1).max(4_096);
export const oauth2CallbackErrorSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x20-\x7e]+$/u);

/**
 * A provider answers with a code or an error, never both, and may add its own
 * parameters. A repeated parameter parses as a list and is refused here.
 */
export const oauth2CallbackQuerySchema = z
  .looseObject({
    state: oauth2CallbackStateSchema,
    code: oauth2CallbackCodeSchema.optional(),
    error: oauth2CallbackErrorSchema.optional(),
  })
  .refine((query) => (query.code === undefined) !== (query.error === undefined))
  .transform(({ state, code, error }) =>
    code === undefined
      ? { kind: 'error' as const, state, error: error ?? '' }
      : { kind: 'code' as const, state, code },
  );

/** Only a callback bound to this browser names its connection. */
export const oauth2CallbackLandingSchema = z.discriminatedUnion('result', [
  z
    .object({
      result: z.enum([
        'connected',
        'denied',
        'token_refused',
        'provider_unavailable',
      ]),
      workspaceId: z.uuid(),
      connectionId: z.uuid(),
    })
    .strict()
    .readonly(),
  z
    .object({ result: z.literal('invalid') })
    .strict()
    .readonly(),
]);

export type OAuth2ClientSettings = z.output<typeof oauth2ClientSettingsSchema>;
export type OAuth2Credential = z.output<typeof oauth2CredentialSchema>;
export type OAuth2ConnectionResponse = z.output<
  typeof oauth2ConnectionResponseSchema
>;
export type OAuth2ConnectionErrorCode = z.output<
  typeof oauth2ConnectionErrorCodeSchema
>;
export type OAuth2StepFailureCode = z.output<
  typeof oauth2StepFailureCodeSchema
>;
export type OAuth2AuthorizationStartResponse = z.output<
  typeof oauth2AuthorizationStartResponseSchema
>;
export type OAuth2CallbackLanding = z.output<
  typeof oauth2CallbackLandingSchema
>;

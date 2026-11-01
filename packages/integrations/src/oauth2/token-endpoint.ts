import { Buffer } from 'node:buffer';

import {
  oauth2ServiceErrorSchema,
  type OAuth2ClientSettings,
  type OAuth2ServiceError,
} from '@pertexo/contracts';

import { parseBoundedRetryAfterMillis } from '../http/retry-after.js';
import {
  SECURE_HTTP_ERROR_CODE,
  inspectSecureHttpError,
  type SecureHttpErrorCode,
} from '../http/secure-error.js';
import type { SecureHttpClient } from '../http/secure.js';

const TOKEN_REQUEST_TIMEOUT_MILLIS = 15_000;
const MAXIMUM_RESPONSE_BYTES = 65_536;
const MAXIMUM_ACCESS_TOKEN_LENGTH = 8_000;
const MAXIMUM_REFRESH_TOKEN_LENGTH = 16_384;
const MAXIMUM_EXPIRES_IN_SECONDS = 315_360_000;
const MAXIMUM_RETRY_AFTER_MILLIS = 60_000;
const DEFAULT_BLOCK_SECONDS = 15;

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/u;
/** Standard names, plus what Entra and GitHub send for the same thing. */
const GRANT_LOST = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'bad_refresh_token',
]);
const CLIENT_REFUSED = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
  'unsupported_grant_type',
  'incorrect_client_credentials',
]);
const TEMPORARY = new Set(['server_error', 'temporarily_unavailable']);

/** The two names RFC 6749 gives an outage, at the token address and at consent alike. */
export const isTemporaryOAuth2Error = (error: string): boolean =>
  TEMPORARY.has(error);
/** The service answered, or the address is wrong: another try won't help. */
const UNUSABLE_FAILURES: ReadonlySet<SecureHttpErrorCode> = new Set([
  SECURE_HTTP_ERROR_CODE.redirectRejected,
  SECURE_HTTP_ERROR_CODE.responseTooLarge,
  SECURE_HTTP_ERROR_CODE.responseEncodingRejected,
  SECURE_HTTP_ERROR_CODE.invalidRequest,
]);

export type OAuth2TokenRequest =
  | Readonly<{
      grantType: 'authorization_code';
      code: string;
      redirectUri: string;
      codeVerifier?: string;
    }>
  | Readonly<{ grantType: 'refresh_token'; refreshToken: string }>
  | Readonly<{ grantType: 'client_credentials' }>;

/** Every way a token address can answer, one row of the plan's table each. */
export type OAuth2TokenAnswer =
  | Readonly<{
      kind: 'issued';
      accessToken: string;
      refreshToken?: string;
      expiresInSeconds: number | null;
    }>
  | Readonly<{ kind: 'grant_lost' }>
  | Readonly<{ kind: 'client_refused' }>
  | Readonly<{ kind: 'rate_limited'; retryAfterSeconds: number }>
  | Readonly<{ kind: 'unavailable'; retryAfterSeconds: number }>
  | Readonly<{
      kind: 'invalid';
      retryAfterSeconds: number;
      /** The service's own `error`, when it names one safely: something to act on. */
      serviceError?: OAuth2ServiceError;
    }>
  | Readonly<{ kind: 'address_blocked' }>;

const UNAVAILABLE = Object.freeze({
  kind: 'unavailable',
  retryAfterSeconds: DEFAULT_BLOCK_SECONDS,
});
const INVALID = Object.freeze({
  kind: 'invalid',
  retryAfterSeconds: DEFAULT_BLOCK_SECONDS,
});

/** A renewal with nothing to send: the same row as an answer Pertexo can't use. */
export const UNUSABLE_TOKEN_ANSWER: OAuth2TokenAnswer = INVALID;

/** RFC 6749 §2.3.1: both parts are form-encoded before Base64, so `+` and `/` survive. */
function basicCredentials(clientId: string, clientSecret: string): string {
  const encode = (value: string): string =>
    new URLSearchParams({ v: value }).toString().slice(2);
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
}

function requestForm(
  settings: OAuth2ClientSettings,
  clientSecret: string,
  request: OAuth2TokenRequest,
): URLSearchParams {
  const form = new URLSearchParams({ grant_type: request.grantType });
  if (request.grantType === 'authorization_code') {
    form.set('code', request.code);
    form.set('redirect_uri', request.redirectUri);
    if (request.codeVerifier !== undefined)
      form.set('code_verifier', request.codeVerifier);
  } else if (request.grantType === 'refresh_token') {
    form.set('refresh_token', request.refreshToken);
  } else if (settings.scope !== '') {
    form.set('scope', settings.scope);
  }
  if (settings.clientAuthentication === 'body') {
    form.set('client_id', settings.clientId);
    form.set('client_secret', clientSecret);
  }
  for (const [name, value] of Object.entries(settings.tokenParameters))
    form.set(name, value);
  return form;
}

/**
 * The refresh token stays out of the sensitive values: a service that doesn't
 * rotate echoes it, and redacting that answer would store a broken copy.
 */
function sensitiveValuesOf(
  clientSecret: string,
  authorization: string | undefined,
  request: OAuth2TokenRequest,
): readonly string[] {
  return [
    clientSecret,
    ...(authorization === undefined ? [] : [authorization]),
    ...(request.grantType === 'authorization_code'
      ? [
          request.code,
          ...(request.codeVerifier === undefined ? [] : [request.codeVerifier]),
        ]
      : []),
  ];
}

function parseExpiresIn(value: unknown): number | null {
  const seconds =
    typeof value === 'string' && /^\d{1,10}$/u.test(value)
      ? Number(value)
      : value;
  return typeof seconds === 'number' &&
    Number.isInteger(seconds) &&
    seconds > 0 &&
    seconds <= MAXIMUM_EXPIRES_IN_SECONDS
    ? seconds
    : null;
}

function parseIssued(body: Record<string, unknown>): OAuth2TokenAnswer {
  const { access_token: accessToken, expires_in: expiresIn } = body;
  // Some services write an absent field as null or, for this one, an empty string.
  const refreshToken =
    body.refresh_token === null || body.refresh_token === ''
      ? undefined
      : body.refresh_token;
  const tokenType = body.token_type ?? undefined;
  const usableAccessToken =
    typeof accessToken === 'string' &&
    accessToken.length <= MAXIMUM_ACCESS_TOKEN_LENGTH &&
    PRINTABLE_ASCII.test(accessToken);
  const usableRefreshToken =
    refreshToken === undefined ||
    (typeof refreshToken === 'string' &&
      refreshToken.length <= MAXIMUM_REFRESH_TOKEN_LENGTH &&
      PRINTABLE_ASCII.test(refreshToken));
  const usableTokenType =
    tokenType === undefined ||
    (typeof tokenType === 'string' && tokenType.toLowerCase() === 'bearer');
  if (!usableAccessToken || !usableRefreshToken || !usableTokenType)
    return INVALID;
  return Object.freeze({
    kind: 'issued',
    accessToken,
    ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
    expiresInSeconds: parseExpiresIn(expiresIn),
  });
}

function parseBody(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    bytes.fill(0);
  }
}

/** A date or a zero says nothing useful about when to ask again, so the default stands. */
function rateLimitBlockSeconds(retryAfter: string | undefined): number {
  return retryAfter !== undefined && /^0*[1-9]\d{0,8}$/u.test(retryAfter)
    ? parseBoundedRetryAfterMillis(retryAfter, MAXIMUM_RETRY_AFTER_MILLIS) /
        1_000
    : DEFAULT_BLOCK_SECONDS;
}

function classifyAnswer(
  status: number,
  retryAfter: string | undefined,
  bytes: Uint8Array,
): OAuth2TokenAnswer {
  const body = parseBody(bytes);
  if (status === 429)
    return Object.freeze({
      kind: 'rate_limited',
      retryAfterSeconds: rateLimitBlockSeconds(retryAfter),
    });
  if (status >= 500) return UNAVAILABLE;
  if (body === undefined) return INVALID;
  // Some services, GitHub among them, answer 200 with an `error` field.
  const error = body.error;
  if (typeof error === 'string') {
    if (GRANT_LOST.has(error)) return Object.freeze({ kind: 'grant_lost' });
    if (CLIENT_REFUSED.has(error))
      return Object.freeze({ kind: 'client_refused' });
    if (TEMPORARY.has(error)) return UNAVAILABLE;
    const named = oauth2ServiceErrorSchema.safeParse(error);
    return named.success
      ? Object.freeze({ ...INVALID, serviceError: named.data })
      : INVALID;
  }
  return status >= 200 && status <= 299 ? parseIssued(body) : INVALID;
}

function classifyFailure(error: unknown): OAuth2TokenAnswer {
  const code = inspectSecureHttpError(error)?.code;
  if (code === undefined) throw error;
  if (code === SECURE_HTTP_ERROR_CODE.ssrfBlocked)
    return Object.freeze({ kind: 'address_blocked' });
  return UNUSABLE_FAILURES.has(code) ? INVALID : UNAVAILABLE;
}

/**
 * One token request. It never follows a redirect, and it has no step signal: a
 * consumed code or a rotated token must not be lost to a closed tab or canceled step.
 */
export async function requestOAuth2Token(
  client: Pick<SecureHttpClient, 'execute'>,
  settings: OAuth2ClientSettings,
  clientSecret: string,
  request: OAuth2TokenRequest,
): Promise<OAuth2TokenAnswer> {
  const authorization =
    settings.clientAuthentication === 'basic'
      ? basicCredentials(settings.clientId, clientSecret)
      : undefined;
  const form = new TextEncoder().encode(
    requestForm(settings, clientSecret, request).toString(),
  );
  try {
    const response = await client.execute({
      url: settings.tokenUrl,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: form,
      timeoutMillis: TOKEN_REQUEST_TIMEOUT_MILLIS,
      maxRedirects: 0,
      maxResponseBytes: MAXIMUM_RESPONSE_BYTES,
      sensitiveValues: sensitiveValuesOf(clientSecret, authorization, request),
      beforeDispatch: () => Promise.resolve(),
    });
    return classifyAnswer(
      response.status,
      response.headers['retry-after'],
      response.body,
    );
  } catch (error: unknown) {
    return classifyFailure(error);
  } finally {
    form.fill(0);
  }
}

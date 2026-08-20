import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type KeyInput,
} from 'jose';
import { z } from 'zod';

import {
  IdentityError,
  type OidcAuthorizationRequest,
  type OidcProviderPort,
  type OidcTokenResponse,
} from '../identity/index.js';

const SIGNING_ALGORITHMS = [
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

const adapterConfigurationSchema = z
  .object({
    issuer: z.url().max(2_048),
    authorizationEndpoint: z.url().max(2_048),
    tokenEndpoint: z.url().max(2_048),
    jwksUri: z.url().max(2_048),
    redirectUri: z.url().max(2_048),
    clientId: z.string().trim().min(1).max(256),
    clientSecret: z.string().min(1).max(512).optional(),
    allowedAlgorithms: z
      .array(z.enum(SIGNING_ALGORITHMS))
      .min(1)
      .max(SIGNING_ALGORITHMS.length),
    timeoutMillis: z.number().int().positive().max(30_000),
    maxTokenResponseBytes: z
      .number()
      .int()
      .positive()
      .max(262_144)
      .default(65_536),
    maxTokenAgeSeconds: z.number().int().positive().max(3_600).default(600),
    clockToleranceSeconds: z.number().int().min(0).max(300).default(30),
    allowInsecureHttpForTests: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.allowInsecureHttpForTests) return;
    for (const [name, endpoint] of Object.entries(value)) {
      if (
        name.endsWith('Endpoint') ||
        name === 'issuer' ||
        name === 'jwksUri'
      ) {
        if (typeof endpoint === 'string' && !endpoint.startsWith('https://')) {
          context.addIssue({
            code: 'custom',
            path: [name],
            message: 'OIDC endpoints must use HTTPS',
          });
        }
      }
    }
  });

const tokenResponseSchema = z.object({
  id_token: z.string().min(1).max(65_536),
});

const verifiedClaimsSchema = z.object({
  iss: z.url().max(2_048),
  sub: z.string().min(1).max(512),
  aud: z.union([
    z.string().min(1).max(512),
    z.array(z.string().min(1).max(512)).min(1).max(32),
  ]),
  nonce: z.string().min(1).max(512),
  azp: z.string().min(1).max(512).optional(),
  email: z.string().trim().pipe(z.email().max(320)).optional(),
  name: z.string().trim().min(1).max(256).optional(),
  email_verified: z.boolean().optional(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
});

export type GenericOidcAdapterConfiguration = Readonly<
  z.input<typeof adapterConfigurationSchema>
>;
type ParsedGenericOidcAdapterConfiguration = z.output<
  typeof adapterConfigurationSchema
>;

export const genericOidcAdapterConfigurationSchema = adapterConfigurationSchema;

type FetchLike = typeof fetch;
type VerificationKey = KeyInput | ReturnType<typeof createRemoteJWKSet>;

type GenericOidcAdapterOptions = Readonly<{
  fetch?: FetchLike;
  verificationKey?: KeyInput;
  remoteJwks?: ReturnType<typeof createRemoteJWKSet>;
}>;

/** Generic OIDC protocol adapter. Provider credentials and tokens never cross this boundary. */
export class GenericOidcProviderAdapter implements OidcProviderPort {
  private readonly configuration: ParsedGenericOidcAdapterConfiguration;
  private readonly fetchImpl: FetchLike;
  private readonly verificationKey: VerificationKey;
  constructor(
    configuration: GenericOidcAdapterConfiguration,
    options: GenericOidcAdapterOptions = {},
  ) {
    try {
      this.configuration = adapterConfigurationSchema.parse(configuration);
      validateEndpointProtocols(this.configuration);
    } catch {
      throw new IdentityError('identity.invalid_input');
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new IdentityError('identity.invalid_input');
    }
    this.verificationKey =
      options.verificationKey ??
      options.remoteJwks ??
      createRemoteJWKSet(new URL(this.configuration.jwksUri), {
        timeoutDuration: this.configuration.timeoutMillis,
        [customFetch]: (url, fetchOptions) => this.fetchJwks(url, fetchOptions),
      });
  }

  authorizationUrl(request: OidcAuthorizationRequest): string {
    if (
      (request as unknown as { codeChallengeMethod: string })
        .codeChallengeMethod !== 'S256' ||
      request.state.length < 16 ||
      request.state.length > 512 ||
      request.nonce.length < 16 ||
      request.nonce.length > 512 ||
      request.codeChallenge.length < 32 ||
      request.codeChallenge.length > 512 ||
      request.redirectUri.length > 2_048 ||
      request.redirectUri !== this.configuration.redirectUri ||
      request.clientId !== this.configuration.clientId ||
      !/^[A-Za-z0-9_-]{16,512}$/u.test(request.state) ||
      !/^[A-Za-z0-9_-]{16,512}$/u.test(request.nonce) ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(request.codeChallenge) ||
      request.scopes.length < 1 ||
      request.scopes.length > 16 ||
      request.scopes.some((scope) => !/^[A-Za-z0-9._:-]{1,64}$/u.test(scope))
    ) {
      throw new IdentityError('identity.invalid_input');
    }
    const url = new URL(this.configuration.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', request.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', request.scopes.join(' '));
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (url.toString().length > 8_192) {
      throw new IdentityError('identity.invalid_input');
    }
    return url.toString();
  }

  async exchangeCode(
    input: Readonly<{
      code: string;
      codeVerifier: string;
      redirectUri: string;
    }>,
  ): Promise<OidcTokenResponse> {
    if (
      input.code.length < 1 ||
      input.code.length > 4_096 ||
      input.codeVerifier.length < 43 ||
      input.codeVerifier.length > 128 ||
      !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier) ||
      input.redirectUri.length > 2_048 ||
      input.redirectUri !== this.configuration.redirectUri
    ) {
      throw new IdentityError('identity.provider_rejected');
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const headers = new Headers({
      'content-type': 'application/x-www-form-urlencoded',
    });
    if (this.configuration.clientSecret === undefined) {
      form.set('client_id', this.configuration.clientId);
    } else {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(
          `${formEncode(this.configuration.clientId)}:${formEncode(this.configuration.clientSecret)}`,
          'utf8',
        ).toString('base64')}`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.configuration.timeoutMillis);
    let response: Response;
    try {
      response = await this.fetchImpl(this.configuration.tokenEndpoint, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      clearTimeout(timeout);
      throw new IdentityError('identity.provider_rejected');
    }
    let body: string;
    try {
      if (hasCrossOriginRedirect(response, this.configuration.tokenEndpoint)) {
        throw new Error('cross-origin token redirect');
      }
      const bytes = await readBoundedResponse(
        response,
        this.configuration.maxTokenResponseBytes,
        controller.signal,
      );
      body = new TextDecoder().decode(bytes);
    } catch {
      clearTimeout(timeout);
      throw new IdentityError('identity.provider_rejected');
    }
    clearTimeout(timeout);
    if (!response.ok) {
      throw new IdentityError('identity.provider_rejected');
    }

    let tokenResponse: z.output<typeof tokenResponseSchema>;
    try {
      tokenResponse = tokenResponseSchema.parse(JSON.parse(body) as unknown);
    } catch {
      throw new IdentityError('identity.provider_rejected');
    }

    let claims: z.output<typeof verifiedClaimsSchema>;
    try {
      const verified = await jwtVerify(
        tokenResponse.id_token,
        this.verificationKey,
        {
          issuer: this.configuration.issuer,
          audience: this.configuration.clientId,
          algorithms: this.configuration.allowedAlgorithms,
          clockTolerance: this.configuration.clockToleranceSeconds,
          maxTokenAge: `${String(this.configuration.maxTokenAgeSeconds)}s`,
        },
      );
      claims = verifiedClaimsSchema.parse(verified.payload);
      if (
        Array.isArray(claims.aud) &&
        claims.aud.length > 1 &&
        claims.azp !== this.configuration.clientId
      ) {
        throw new Error('authorized party mismatch');
      }
    } catch {
      throw new IdentityError('identity.provider_rejected');
    }

    return Object.freeze({
      issuer: claims.iss,
      subject: claims.sub,
      audience: claims.aud,
      nonce: claims.nonce,
      ...(claims.email === undefined ? {} : { email: claims.email }),
      ...(claims.name === undefined ? {} : { displayName: claims.name }),
      ...(claims.email_verified === undefined
        ? {}
        : { emailVerified: claims.email_verified }),
    });
  }

  private async fetchJwks(
    url: string,
    options: {
      headers: Headers;
      method: 'GET';
      redirect: 'manual';
      signal: AbortSignal;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.configuration.timeoutMillis);
    const abort = (): void => {
      controller.abort();
    };
    options.signal.addEventListener('abort', abort, { once: true });
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (hasCrossOriginRedirect(response, this.configuration.jwksUri)) {
        throw new Error('cross-origin JWKS redirect');
      }
      const bytes = await readBoundedResponse(
        response,
        262_144,
        controller.signal,
      );
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
    }
  }
}

function validateEndpointProtocols(
  configuration: ParsedGenericOidcAdapterConfiguration,
): void {
  const endpoints = [
    configuration.issuer,
    configuration.authorizationEndpoint,
    configuration.tokenEndpoint,
    configuration.jwksUri,
    configuration.redirectUri,
  ];
  for (const endpoint of endpoints) {
    const parsed = new URL(endpoint);
    if (
      (!configuration.allowInsecureHttpForTests &&
        parsed.protocol !== 'https:') ||
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error('invalid OIDC endpoint');
    }
  }
}

function hasCrossOriginRedirect(
  response: Response,
  expectedUrl: string,
): boolean {
  if (
    response.url !== '' &&
    new URL(response.url).origin !== new URL(expectedUrl).origin
  ) {
    return true;
  }
  return response.status >= 300 && response.status < 400;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new Error('invalid content length');
    }
    const parsedLength = Number(contentLength);
    if (
      !Number.isFinite(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maxBytes
    ) {
      throw new Error('response too large');
    }
  }
  const reader =
    response.body === null
      ? undefined
      : (response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>);
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error('response aborted');
      const result: unknown = await readChunk(reader, signal);
      if (
        typeof result !== 'object' ||
        result === null ||
        !('done' in result) ||
        typeof result.done !== 'boolean'
      ) {
        throw new Error('invalid response stream');
      }
      if (result.done) break;
      if (!('value' in result) || !(result.value instanceof Uint8Array)) {
        throw new Error('invalid response stream');
      }
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('response too large');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {
      /* already cancelled */
    });
    throw error;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error('response aborted');
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel().catch(() => {
        /* already cancelled */
      });
      reject(new Error('response aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const readPromise = reader.read() as Promise<unknown>;
    readPromise.then(
      (result: unknown) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error ? error : new Error('response read failed'),
        );
      },
    );
  });
}

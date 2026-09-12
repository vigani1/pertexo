import { once } from 'node:events';
import { createServer } from 'node:http';

import { generateKeyPair, SignJWT, type KeyInput } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  digestBase64Url,
  nodeIdentityCrypto,
  type OidcAuthorizationRequest,
} from '../../src/identity/index.js';
import {
  GenericOidcProviderAdapter,
  type GenericOidcAdapterConfiguration,
} from '../../src/identity-infrastructure/index.js';

const configuration: GenericOidcAdapterConfiguration = {
  issuer: 'https://issuer.example.test',
  authorizationEndpoint: 'https://issuer.example.test/authorize',
  tokenEndpoint: 'https://issuer.example.test/token',
  jwksUri: 'https://issuer.example.test/.well-known/jwks.json',
  redirectUri: 'https://app.example.test/auth/callback',
  clientId: 'pertexo-web',
  clientSecret: 'client-secret',
  allowedAlgorithms: ['RS256'],
  timeoutMillis: 50,
  maxTokenResponseBytes: 1_024,
};

const request: OidcAuthorizationRequest = {
  state: 'state-value-that-is-long-enough',
  nonce: 'nonce-value-that-is-long-enough',
  codeChallenge: digestBase64Url('a'.repeat(43), nodeIdentityCrypto),
  codeChallengeMethod: 'S256',
  redirectUri: 'https://app.example.test/auth/callback',
  clientId: configuration.clientId,
  scopes: ['openid', 'profile', 'email'],
};

async function signedToken(
  privateKey: KeyInput,
  claims: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return new SignJWT({
    iss: configuration.issuer,
    sub: 'subject-123',
    aud: configuration.clientId,
    nonce: request.nonce,
    email: 'person@example.test',
    name: 'Test Person',
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function responseFetch(
  body: string,
  capture: { init: RequestInit | undefined; url?: string } = {
    init: undefined,
  },
): typeof fetch {
  return (input, init) => {
    capture.url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    capture.init = init;
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

function adapterWithToken(
  token: string,
  publicKey: KeyInput,
  fetchImpl?: typeof fetch,
): {
  adapter: GenericOidcProviderAdapter;
  fetchCapture: { init: RequestInit | undefined; url?: string };
} {
  const fetchCapture: { init: RequestInit | undefined; url?: string } = {
    init: undefined,
  };
  const adapter = new GenericOidcProviderAdapter(configuration, {
    verificationKey: publicKey,
    fetch:
      fetchImpl ??
      responseFetch(JSON.stringify({ id_token: token }), fetchCapture),
  });
  const authorization = adapter.authorizationUrl(request);
  const url = new URL(authorization);
  expect(url.searchParams.get('state')).toBe(request.state);
  expect(url.searchParams.get('nonce')).toBe(request.nonce);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  return { adapter, fetchCapture };
}

describe('generic OIDC provider adapter', () => {
  it('rejects a host without a callable Fetch implementation', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => new GenericOidcProviderAdapter(configuration)).toThrow(
        expect.objectContaining({ code: 'identity.invalid_input' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects an authorization URL whose valid encoded inputs exceed the final bound', () => {
    const authorizationPrefix = 'https://issuer.example.test/';
    const redirectPrefix = 'https://app.example.test/';
    const authorizationEndpoint = `${authorizationPrefix}${'a'.repeat(2_048 - authorizationPrefix.length)}`;
    const redirectUri = `${redirectPrefix}${'r'.repeat(2_048 - redirectPrefix.length)}`;
    const adapter = new GenericOidcProviderAdapter({
      ...configuration,
      authorizationEndpoint,
      redirectUri,
    });

    expect(() =>
      adapter.authorizationUrl({
        ...request,
        state: 's'.repeat(512),
        nonce: 'n'.repeat(512),
        codeChallenge: 'c'.repeat(128),
        redirectUri,
        scopes: Array.from({ length: 16 }, () => ':'.repeat(64)),
      }),
    ).toThrow(expect.objectContaining({ code: 'identity.invalid_input' }));
  });

  it.each([
    ['short state', { state: 'too-short' }],
    ['long state', { state: 's'.repeat(513) }],
    ['short nonce', { nonce: 'too-short' }],
    ['long nonce', { nonce: 'n'.repeat(513) }],
    ['short code challenge', { codeChallenge: 'c'.repeat(31) }],
    ['long code challenge', { codeChallenge: 'c'.repeat(513) }],
    [
      'long redirect URI',
      { redirectUri: `https://example.test/${'r'.repeat(2_048)}` },
    ],
    [
      'unregistered redirect URI',
      { redirectUri: 'https://evil.example.test/callback' },
    ],
    ['unregistered client', { clientId: 'other-client' }],
    ['invalid state syntax', { state: `state${'s'.repeat(20)}!` }],
    ['invalid nonce syntax', { nonce: `nonce${'n'.repeat(20)}!` }],
    ['invalid challenge syntax', { codeChallenge: '!'.repeat(43) }],
    ['missing scopes', { scopes: [] }],
    ['too many scopes', { scopes: Array.from({ length: 17 }, () => 'openid') }],
    ['invalid scope syntax', { scopes: ['openid', 'not valid'] }],
  ] satisfies readonly (readonly [
    string,
    Partial<OidcAuthorizationRequest>,
  ])[])('rejects an authorization request with %s', (_name, invalidFields) => {
    const adapter = new GenericOidcProviderAdapter(configuration);
    expect(() =>
      adapter.authorizationUrl({ ...request, ...invalidFields }),
    ).toThrow(expect.objectContaining({ code: 'identity.invalid_input' }));
  });

  it.each([
    ['missing code', { code: '' }],
    ['oversized code', { code: 'c'.repeat(4_097) }],
    ['short verifier', { codeVerifier: 'v'.repeat(42) }],
    ['long verifier', { codeVerifier: 'v'.repeat(129) }],
    ['invalid verifier syntax', { codeVerifier: '!'.repeat(43) }],
    [
      'oversized redirect URI',
      { redirectUri: `https://example.test/${'r'.repeat(2_048)}` },
    ],
    [
      'unregistered redirect URI',
      { redirectUri: 'https://evil.example.test/callback' },
    ],
  ] as const)(
    'rejects a token exchange with %s before provider dispatch',
    async (_name, invalidFields) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const adapter = new GenericOidcProviderAdapter(configuration, {
        fetch: fetchImpl,
      });
      await expect(
        adapter.exchangeCode({
          code: 'one-time-code',
          codeVerifier: 'a'.repeat(43),
          redirectUri: request.redirectUri,
          ...invalidFields,
        }),
      ).rejects.toMatchObject({ code: 'identity.provider_rejected' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('builds authorization parameters and exchanges only a verified bounded profile', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const { adapter, fetchCapture } = adapterWithToken(token, publicKey);
    const result = await adapter.exchangeCode({
      code: 'one-time-code',
      codeVerifier: 'a'.repeat(43),
      redirectUri: request.redirectUri,
    });

    expect(result).toEqual({
      issuer: configuration.issuer,
      subject: 'subject-123',
      audience: configuration.clientId,
      nonce: request.nonce,
      email: 'person@example.test',
      displayName: 'Test Person',
      emailVerified: true,
    });
    expect(result).not.toHaveProperty('id_token');
    expect(result).not.toHaveProperty('access_token');
    expect(fetchCapture.url).toBe(configuration.tokenEndpoint);
    const capturedHeaders = new Headers(fetchCapture.init?.headers);
    expect(capturedHeaders.get('authorization')).toMatch(/^Basic /u);
    expect(capturedHeaders.get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    const capturedBody = fetchCapture.init?.body;
    const requestBody =
      typeof capturedBody === 'string'
        ? capturedBody
        : capturedBody instanceof URLSearchParams
          ? capturedBody.toString()
          : '';
    expect(requestBody).toContain('code_verifier=');
    expect(requestBody).not.toContain('client-secret');
  });

  it('uses a public-client token request and preserves absent optional claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey, {
      email: undefined,
      name: undefined,
      email_verified: undefined,
    });
    const capture = { init: undefined as RequestInit | undefined };
    const adapter = new GenericOidcProviderAdapter(
      { ...configuration, clientSecret: undefined },
      {
        verificationKey: publicKey,
        fetch: responseFetch(JSON.stringify({ id_token: token }), capture),
      },
    );

    const result = await adapter.exchangeCode({
      code: 'one-time-code',
      codeVerifier: 'a'.repeat(43),
      redirectUri: request.redirectUri,
    });

    expect(new Headers(capture.init?.headers).has('authorization')).toBe(false);
    const body = capture.init?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new TypeError('Expected form body');
    expect(body).toContain('client_id=pertexo-web');
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('displayName');
    expect(result).not.toHaveProperty('emailVerified');
  });

  it('rejects a multi-audience token without this client as authorized party', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey, {
      aud: [configuration.clientId, 'resource-server'],
      azp: 'another-client',
    });
    const { adapter } = adapterWithToken(token, publicKey);

    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_rejected' });
  });

  it('remains stateless across an authorization-instance restart', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const instanceA = new GenericOidcProviderAdapter(configuration, {
      verificationKey: publicKey,
      fetch: responseFetch(JSON.stringify({ id_token: token })),
    });
    instanceA.authorizationUrl(request);
    const instanceB = new GenericOidcProviderAdapter(configuration, {
      verificationKey: publicKey,
      fetch: responseFetch(JSON.stringify({ id_token: token })),
    });
    await expect(
      instanceB.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).resolves.toMatchObject({ nonce: request.nonce });
  });

  it.each([
    ['signature', 'other', undefined, true],
    ['issuer', undefined, { iss: 'https://evil.example.test' }, true],
    ['audience', undefined, { aud: 'other-client' }, true],
    ['nonce', undefined, { nonce: 'wrong-nonce' }, false],
  ] as const)(
    'rejects %s tampering without exposing token material',
    async (_name, keyMutation, claims, shouldReject) => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const signingKey =
        keyMutation === 'other'
          ? (await generateKeyPair('RS256')).privateKey
          : privateKey;
      const token = await signedToken(signingKey, claims);
      const { adapter } = adapterWithToken(token, publicKey);
      const exchange = adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      });
      if (shouldReject) {
        await expect(exchange).rejects.toMatchObject({
          code: 'identity.provider_rejected',
        });
      } else {
        await expect(exchange).resolves.toMatchObject({ nonce: 'wrong-nonce' });
      }
    },
  );

  it('requires bounded OIDC token lifetime claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const baseClaims = {
      iss: configuration.issuer,
      sub: 'subject-123',
      aud: configuration.clientId,
      nonce: request.nonce,
    };
    const now = Math.floor(Date.now() / 1_000);
    const tokens = [
      await new SignJWT(baseClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setExpirationTime(now + 300)
        .sign(privateKey),
      await new SignJWT(baseClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt(now)
        .sign(privateKey),
      await new SignJWT(baseClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt(now - 700)
        .setExpirationTime(now + 300)
        .sign(privateKey),
      await new SignJWT(baseClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt(now - 400)
        .setExpirationTime(now - 120)
        .sign(privateKey),
    ];

    for (const token of tokens) {
      const { adapter } = adapterWithToken(token, publicKey);
      await expect(
        adapter.exchangeCode({
          code: 'one-time-code',
          codeVerifier: 'a'.repeat(43),
          redirectUri: request.redirectUri,
        }),
      ).rejects.toMatchObject({ code: 'identity.provider_rejected' });
    }
  });

  it('classifies transport timeouts and provider 5xx responses as unavailable', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const slowFetch: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('timed out'));
        });
      });
    const slow = adapterWithToken(token, publicKey, slowFetch);
    await expect(
      slow.adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({
      code: 'identity.provider_unavailable',
      status: 503,
    });

    const nonOkFetch: typeof fetch = () =>
      Promise.resolve(new Response('provider-secret-error', { status: 503 }));
    const nonOk = adapterWithToken(token, publicKey, nonOkFetch);
    await expect(
      nonOk.adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({
      code: 'identity.provider_unavailable',
      status: 503,
    });
  });

  it('classifies an ordinary provider 4xx response as rejected', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const { adapter } = adapterWithToken(token, publicKey, () =>
      Promise.resolve(new Response(null, { status: 400 })),
    );

    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_rejected' });
  });

  it('rejects bodyless and non-byte token response bodies', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const bodyless = adapterWithToken(token, publicKey, () =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    await expect(
      bodyless.adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_rejected' });

    const cancelled = vi.fn();
    const malformed = adapterWithToken(token, publicKey, () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue('not bytes');
            },
            cancel: cancelled,
          }) as never,
          { status: 200 },
        ),
      ),
    );
    await expect(
      malformed.adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_rejected' });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'streaming provider error',
      status: 503,
      headers: {},
      code: 'identity.provider_unavailable',
    },
    {
      name: 'redirect',
      status: 302,
      headers: { location: 'https://evil.example.test/token' },
      code: 'identity.provider_rejected',
    },
    {
      name: 'oversized declared response',
      status: 200,
      headers: { 'content-length': '2048' },
      code: 'identity.provider_rejected',
    },
    {
      name: 'invalid declared response length',
      status: 200,
      headers: { 'content-length': 'not-a-number' },
      code: 'identity.provider_rejected',
    },
  ])('cancels the token response transport for $name', async (scenario) => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const cancelled = vi.fn();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel: cancelled,
          }),
          {
            status: scenario.status,
            headers: scenario.headers,
          },
        ),
      );
    const { adapter } = adapterWithToken(token, publicKey, fetchImpl);

    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: scenario.code });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels a token response whose body stalls until the request timeout', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const cancelled = vi.fn();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
            cancel: cancelled,
          }),
          { status: 200 },
        ),
      );
    const { adapter } = adapterWithToken(token, publicKey, fetchImpl);
    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('classifies token body read failures as provider transport failures', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error('provider body failed'));
            },
          }),
          { status: 200 },
        ),
      );
    const { adapter } = adapterWithToken(token, publicKey, fetchImpl);
    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
  });

  it('rejects a response that arrives only after its timeout signal fired', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const { adapter } = adapterWithToken(
      token,
      publicKey,
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(new Response(JSON.stringify({ id_token: token })));
          }, configuration.timeoutMillis + 10);
        }),
    );

    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
  });

  it('rejects a successful token response whose final URL changes origin', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const fetchImpl: typeof fetch = () => {
      const response = new Response(JSON.stringify({ id_token: token }));
      Object.defineProperty(response, 'url', {
        value: 'https://evil.example.test/token',
      });
      return Promise.resolve(response);
    };
    const { adapter } = adapterWithToken(token, publicKey, fetchImpl);

    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_rejected' });
  });

  it('keeps invalid token responses and redirects as rejected callbacks', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);

    const boundedFetch: typeof fetch = () =>
      Promise.resolve(new Response('x'.repeat(2_000), { status: 200 }));
    const bounded = adapterWithToken(token, publicKey, boundedFetch);
    await expect(
      bounded.adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({
      code: 'identity.provider_rejected',
      status: 400,
    });

    const streamingFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(800));
              controller.enqueue(new Uint8Array(800));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );
    const streaming = adapterWithToken(token, publicKey, streamingFetch);
    await expect(
      streaming.adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_rejected' });

    const redirectFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.test/token' },
        }),
      );
    const redirected = adapterWithToken(token, publicKey, redirectFetch);
    await expect(
      redirected.adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_rejected' });
  });

  it('classifies remote JWKS endpoint failures as unavailable', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const cancelled = vi.fn();
    const fetchImpl: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === configuration.tokenEndpoint) {
        return Promise.resolve(
          new Response(JSON.stringify({ id_token: token }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('provider-jwks-secret'),
              );
            },
            cancel: cancelled,
          }),
          { status: 503 },
        ),
      );
    };
    const adapter = new GenericOidcProviderAdapter(configuration, {
      fetch: fetchImpl,
    });

    try {
      await adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      });
      throw new Error('expected JWKS failure');
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: 'identity.provider_unavailable',
        status: 503,
      });
      expect(String(error)).not.toContain('provider-jwks-secret');
    }
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('classifies a valid JWKS document without the requested key as unavailable', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const fetchImpl: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(
        url === configuration.tokenEndpoint
          ? new Response(JSON.stringify({ id_token: token }))
          : new Response(JSON.stringify({ keys: [] })),
      );
    };
    const adapter = new GenericOidcProviderAdapter(configuration, {
      fetch: fetchImpl,
    });

    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
  });

  it('rejects a cross-origin final URL while fetching remote JWKS', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const fetchImpl: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === configuration.tokenEndpoint)
        return Promise.resolve(
          new Response(JSON.stringify({ id_token: token })),
        );
      const response = new Response(JSON.stringify({ keys: [] }));
      Object.defineProperty(response, 'url', {
        value: 'https://evil.example.test/jwks',
      });
      return Promise.resolve(response);
    };
    const adapter = new GenericOidcProviderAdapter(configuration, {
      fetch: fetchImpl,
    });

    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
  });

  it('bounds a provider-response cancellation that settles after the deadline', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const cancelled = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        }),
    );
    const { adapter } = adapterWithToken(token, publicKey, () =>
      Promise.resolve(
        new Response(new ReadableStream({ cancel: cancelled }), {
          status: 503,
        }),
      ),
    );
    await expect(
      adapter.exchangeCode({
        code: 'one-time-code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: request.redirectUri,
      }),
    ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('closes a real streaming provider error response', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    let responseClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const server = createServer((_incoming, outgoing) => {
      outgoing.on('close', () => responseClosed?.());
      outgoing.writeHead(503, { 'content-type': 'text/plain' });
      outgoing.write('provider is unavailable');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('OIDC test server did not bind a TCP port');
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    const adapter = new GenericOidcProviderAdapter(
      {
        ...configuration,
        issuer: endpoint,
        authorizationEndpoint: `${endpoint}/authorize`,
        tokenEndpoint: `${endpoint}/token`,
        jwksUri: `${endpoint}/jwks`,
        allowInsecureHttpForTests: true,
      },
      { verificationKey: publicKey },
    );
    try {
      await expect(
        adapter.exchangeCode({
          code: 'one-time-code',
          codeVerifier: 'a'.repeat(43),
          redirectUri: request.redirectUri,
        }),
      ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
      await expect(
        Promise.race([
          closed.then(() => 'closed'),
          new Promise<string>((resolve) => {
            setTimeout(() => {
              resolve('timed-out');
            }, 500);
          }),
        ]),
      ).resolves.toBe('closed');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });

  it('requires HTTPS unless explicitly opted into test HTTP endpoints', () => {
    expect(
      () =>
        new GenericOidcProviderAdapter({
          ...configuration,
          issuer: 'http://issuer.example.test',
        }),
    ).toThrow(expect.objectContaining({ code: 'identity.invalid_input' }));
    expect(
      () =>
        new GenericOidcProviderAdapter({
          ...configuration,
          issuer: 'http://issuer.example.test',
          authorizationEndpoint: 'http://issuer.example.test/authorize',
          tokenEndpoint: 'http://issuer.example.test/token',
          jwksUri: 'http://issuer.example.test/jwks',
          allowInsecureHttpForTests: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new GenericOidcProviderAdapter({
          ...configuration,
          issuer: 'ftp://issuer.example.test',
          allowInsecureHttpForTests: true,
        }),
    ).toThrow(expect.objectContaining({ code: 'identity.invalid_input' }));
    expect(
      () =>
        new GenericOidcProviderAdapter({
          ...configuration,
          issuer: 'https://user:password@issuer.example.test#fragment',
          allowInsecureHttpForTests: true,
        }),
    ).toThrow(expect.objectContaining({ code: 'identity.invalid_input' }));
  });
});

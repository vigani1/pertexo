import { Readable } from 'node:stream';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createApplicationSecretEnvelope,
  SecureHttpClient,
  type SecureHttpTransportRequest,
} from '@pertexo/integrations/server';
import {
  createOidcProofGateway,
  federationSecretContext,
} from '../../../src/authentication/federation/protocol/oidc.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://idp.example.test/tenant';
const proof = {
  state: 'browser-bound-state',
  nonce: 'browser-bound-nonce',
  codeVerifier: 'v'.repeat(43),
  redirectUri: 'https://app.example.test/v1/auth/federation/oidc/callback',
};
function fixture(
  options: Readonly<{
    claims?: Readonly<Record<string, unknown>>;
    badSignature?: boolean;
    methods?: string[];
    privateEndpoint?: boolean;
    badIssuer?: boolean;
    responseBytes?: number;
  }> = {},
) {
  const envelope = createApplicationSecretEnvelope({
    current: { version: 'v1', key: Buffer.alloc(32, 65).toString('base64') },
  });
  const provider = {
    id: 'provider-1',
    controlWorkspaceId: 'workspace-1',
    issuer,
    configuration: {
      clientId: 'pertexo-client',
      emailClaim: 'email',
      nameClaim: 'name',
      jitEnabled: false,
    },
    sealedSecret: envelope.seal(
      'example-client-secret',
      federationSecretContext('workspace-1', 'provider-1'),
    ),
  };
  const seen: SecureHttpTransportRequest[] = [];
  const dispatch = vi.fn((request: SecureHttpTransportRequest) => {
    seen.push({
      ...request,
      ...(request.body === undefined
        ? {}
        : { body: new Uint8Array(request.body) }),
    });
    let value: unknown;
    if (request.url.pathname.endsWith('/.well-known/openid-configuration'))
      value = {
        issuer: options.badIssuer ? 'https://wrong.example.test' : issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: options.privateEndpoint
          ? 'https://127.0.0.1/token'
          : issuer + '/token',
        jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: options.methods ?? [
          'client_secret_basic',
        ],
      };
    else if (request.url.pathname.endsWith('/jwks'))
      value = {
        keys: [
          {
            ...pair.publicKey.export({ format: 'jwk' }),
            kid: 'key-1',
            use: 'sig',
            alg: 'RS256',
          },
        ],
      };
    else if (request.url.pathname.endsWith('/token')) {
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid: 'key-1' }),
      ).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const body = Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: 'pertexo-client',
          sub: 'immutable-subject',
          iat: now,
          exp: now + 300,
          nonce: proof.nonce,
          email: 'Member@Example.Test',
          name: 'Example member',
          ...options.claims,
        }),
      ).toString('base64url');
      const payload = header + '.' + body;
      const signature = options.badSignature
        ? Buffer.alloc(256)
        : sign('RSA-SHA256', Buffer.from(payload), pair.privateKey);
      value = {
        access_token: 'not-persisted',
        token_type: 'Bearer',
        id_token: payload + '.' + signature.toString('base64url'),
      };
    } else throw new Error('Unexpected fixture request');
    const bytes =
      options.responseBytes === undefined
        ? Buffer.from(JSON.stringify(value))
        : Buffer.alloc(options.responseBytes, 65);
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Readable.from([bytes]),
      close: () => undefined,
    });
  });
  const http = new SecureHttpClient(
    {
      resolve: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    },
    { dispatch },
  );
  return {
    provider,
    gateway: createOidcProofGateway({ http, envelope }),
    seen,
    dispatch,
  };
}
function callback() {
  const url = new URL(proof.redirectUri);
  url.searchParams.set('state', proof.state);
  url.searchParams.set('code', 'one-use-code');
  return url;
}
describe('organization OIDC proof gateway', () => {
  it('uses the real discovery and code-flow SDK with exact state, nonce and S256 PKCE', async () => {
    const { gateway, provider } = fixture();
    const url = new URL(await gateway.authorize(provider, proof));
    expect(url.origin + url.pathname).toBe(issuer + '/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      state: proof.state,
      nonce: proof.nonce,
      redirect_uri: proof.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256')
        .update(proof.codeVerifier)
        .digest('base64url'),
    });
  });
  it.each(['client_secret_basic', 'client_secret_post'])(
    'verifies RSA signatures and chooses supported %s authentication',
    async (method) => {
      const { gateway, provider, seen } = fixture({ methods: [method] });
      const identity = await gateway.verify(provider, proof, callback());
      expect(identity).toEqual({
        subject: 'immutable-subject',
        email: 'member@example.test',
        displayName: 'Example member',
      });
      expect(JSON.stringify(identity)).not.toContain('not-persisted');
      const token = seen.find((request) =>
        request.url.pathname.endsWith('/token'),
      );
      expect(token).toBeDefined();
      const fields = new URLSearchParams(
        Buffer.from(token?.body ?? []).toString('utf8'),
      );
      expect(fields.get('code_verifier')).toBe(proof.codeVerifier);
      expect(fields.get('redirect_uri')).toBe(proof.redirectUri);
      if (method === 'client_secret_basic')
        expect(token?.headers.authorization).toMatch(/^Basic /u);
      else expect(fields.get('client_secret')).toBe('example-client-secret');
    },
  );
  it.each([
    { nonce: 'wrong' },
    { iss: 'https://wrong.example.test' },
    { aud: 'another-client' },
    { exp: 1 },
    { email_verified: false },
    { email_verified: 'true' },
    { email: 'invalid' },
    { sub: '' },
  ])('refuses invalid signed claims %j', async (claims) => {
    const { gateway, provider } = fixture({ claims });
    await expect(
      gateway.verify(provider, proof, callback()),
    ).rejects.toBeDefined();
  });
  it('requires a real signature even when TLS token exchange succeeds', async () => {
    const { gateway, provider } = fixture({ badSignature: true });
    await expect(
      gateway.verify(provider, proof, callback()),
    ).rejects.toBeDefined();
  });
  it('rejects state or callback confusion before exchanging the authorization code', async () => {
    const { gateway, provider, seen } = fixture();
    const wrong = callback();
    wrong.searchParams.set('state', 'other-browser');
    await expect(gateway.verify(provider, proof, wrong)).rejects.toBeDefined();
    expect(
      seen.some((request) => request.url.pathname.endsWith('/token')),
    ).toBe(false);
    await expect(
      gateway.verify(
        provider,
        proof,
        new URL('https://other.example.test/?code=stolen'),
      ),
    ).rejects.toBeDefined();
  });
  it('rejects a discovery issuer mismatch and unsupported client authentication', async () => {
    for (const options of [{ badIssuer: true }, { methods: ['none'] }]) {
      const { gateway, provider } = fixture(options);
      await expect(gateway.authorize(provider, proof)).rejects.toBeDefined();
    }
  });
  it('keeps private-network endpoints behind the existing address policy', async () => {
    const { gateway, provider, seen } = fixture({ privateEndpoint: true });
    await expect(
      gateway.verify(provider, proof, callback()),
    ).rejects.toBeDefined();
    expect(seen.some((request) => request.url.hostname === '127.0.0.1')).toBe(
      false,
    );
  });
  it('bounds discovery bodies before the SDK parses them', async () => {
    const { gateway, provider } = fixture({ responseBytes: 262145 });
    await expect(gateway.authorize(provider, proof)).rejects.toBeDefined();
  });
});

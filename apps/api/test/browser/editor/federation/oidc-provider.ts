import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  SecureHttpClient,
  type SecureHttpTransport,
} from '@pertexo/integrations/server';

import { liveWebOrigin } from '../../web-origin.js';

function validClientAuthorization(
  header: string | undefined,
  clientId: string,
): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const fields = Buffer.from(header.slice(6), 'base64')
    .toString('utf8')
    .split(':');
  if (fields.length !== 2) return false;
  try {
    return (
      decodeURIComponent(fields[0] ?? '') === clientId &&
      decodeURIComponent(fields[1] ?? '') === 'owned-browser-secret'
    );
  } catch {
    return false;
  }
}

/** Owned HTTPS IdP: real discovery, code exchange, PKCE, nonce and JWT verification. */
export async function createBrowserOidcProvider() {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-oidc-'));
  const keyPath = join(directory, 'key.pem'),
    certPath = join(directory, 'cert.pem');
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ]);
  const key = await readFile(keyPath),
    cert = await readFile(certPath);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const grants = new Map<
    string,
    {
      email: string;
      clientId: string;
      nonce: string;
      challenge: string;
      redirectUri: string;
    }
  >();
  let origin = '';
  const server = createServer({ key, cert }, (incoming, response) => {
    const url = new URL(incoming.url ?? '/', origin);
    const json = (value: unknown) =>
      response
        .writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        })
        .end(JSON.stringify(value));
    if (url.pathname === '/.well-known/openid-configuration') {
      json({
        issuer: origin,
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token',
        jwks_uri: origin + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      json({
        keys: [
          {
            ...pair.publicKey.export({ format: 'jwk' }),
            kid: 'owned-key',
            use: 'sig',
            alg: 'RS256',
          },
        ],
      });
      return;
    }
    if (url.pathname === '/authorize' && incoming.method === 'GET') {
      const email = url.searchParams.get('email');
      if (email === null) {
        const fields = [
          'state',
          'nonce',
          'code_challenge',
          'redirect_uri',
          'client_id',
        ];
        if (
          fields.some(
            (field) =>
              !/^[a-zA-Z0-9:/?._~%+-]{1,2048}$/u.test(
                url.searchParams.get(field) ?? '',
              ),
          )
        ) {
          response.writeHead(400).end();
          return;
        }
        response
          .writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          .end(
            `<main><h1>Local organization provider</h1><form method="get">${fields.map((field) => `<input type="hidden" name="${field}" value="${url.searchParams.get(field) ?? ''}">`).join('')}<label>Organization email<input name="email" type="email" required></label><button>Verify organization identity</button></form></main>`,
          );
        return;
      }
      if (
        !/^[a-zA-Z0-9@._+-]{1,320}$/u.test(email) ||
        !email.endsWith('.integration.test')
      ) {
        response.writeHead(400).end();
        return;
      }
      const code = randomUUID(),
        redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (new URL(redirectUri).origin !== liveWebOrigin) {
        response.writeHead(400).end();
        return;
      }
      grants.set(code, {
        email,
        clientId: url.searchParams.get('client_id') ?? '',
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri,
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      callback.searchParams.set('code', code);
      response
        .writeHead(302, {
          location: callback.toString(),
          'cache-control': 'no-store',
        })
        .end();
      return;
    }
    if (url.pathname === '/token' && incoming.method === 'POST') {
      let body = '';
      incoming.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 65536) incoming.destroy();
      });
      incoming.on('end', () => {
        const fields = new URLSearchParams(body),
          code = fields.get('code') ?? '',
          grant = grants.get(code);
        grants.delete(code);
        if (grant === undefined) {
          response
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        if (
          fields.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(fields.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge ||
          !validClientAuthorization(
            incoming.headers.authorization,
            grant.clientId,
          )
        ) {
          response
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const now = Math.floor(Date.now() / 1000),
          header = Buffer.from(
            JSON.stringify({ alg: 'RS256', kid: 'owned-key' }),
          ).toString('base64url');
        const claims = Buffer.from(
          JSON.stringify({
            iss: origin,
            aud: grant.clientId,
            sub: grant.email,
            email: grant.email,
            email_verified: true,
            name: 'Organization member',
            nonce: grant.nonce,
            iat: now,
            exp: now + 300,
          }),
        ).toString('base64url');
        const payload = header + '.' + claims;
        json({
          access_token: 'discarded-owned-token',
          token_type: 'Bearer',
          id_token:
            payload +
            '.' +
            sign('RSA-SHA256', Buffer.from(payload), pair.privateKey).toString(
              'base64url',
            ),
        });
      });
      return;
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Owned IdP listener missing');
  origin = `https://localhost:${String(address.port)}`;
  const transport: SecureHttpTransport = {
    dispatch: (input) =>
      new Promise((resolve, reject) => {
        if (input.url.origin !== origin) {
          reject(new Error('Unowned identity endpoint'));
          return;
        }
        const outgoing = request(
          input.url,
          {
            ca: cert,
            agent: false,
            lookup: (_host, options, callback) => {
              if (options.all)
                callback(null, [{ address: '127.0.0.1', family: 4 }]);
              else callback(null, '127.0.0.1', 4);
            },
            method: input.method,
            headers: input.headers,
            signal: input.signal,
          },
          (received) => {
            resolve({
              status: received.statusCode ?? 0,
              headers: { ...received.headers },
              body: received,
              close: () => {
                received.destroy();
              },
            });
          },
        );
        outgoing.setTimeout(input.timeoutMillis, () =>
          outgoing.destroy(new Error('Owned IdP timeout')),
        );
        outgoing.once('error', reject);
        outgoing.end(input.body);
      }),
  };
  return {
    origin,
    http: new SecureHttpClient(
      {
        resolve: () =>
          Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      },
      transport,
    ),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

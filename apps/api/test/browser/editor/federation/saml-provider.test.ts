import { createServer } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureResourceOwner } from '../../harness/resource-owner.js';
import { signingMaterial } from '../../../authentication/federation/saml/fixture.js';
import {
  createSamlProofGateway,
  samlServiceProviderMetadata,
} from '../../../../src/authentication/federation/protocol/saml/gateway.js';
import {
  createBrowserSamlProvider,
  createSamlAppProxy,
} from './saml-provider.js';

let owner = new FixtureResourceOwner();
afterEach(async () => {
  await owner.close();
  owner = new FixtureResourceOwner();
});
async function upstream() {
  const paths: string[] = [];
  const server = owner.acquire(
    'owned upstream',
    createServer((incoming, outgoing) => {
      paths.push(incoming.url ?? '/');
      outgoing.end('owned upstream');
    }),
    async (value) => {
      value.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        value.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Owned upstream missing');
  return { origin: `http://127.0.0.1:${String(address.port)}`, paths };
}
async function read(
  url: string | URL,
  ca: string,
  options: RequestOptions = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      url,
      { ...options, ca, agent: false },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    outgoing.setTimeout(3000, () =>
      outgoing.destroy(new Error('Owned probe timeout')),
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}
describe('owned SAML browser transport boundaries', () => {
  it('keeps both proxy destinations fixed and refuses absolute/network request targets', async () => {
    const api = await upstream(),
      web = await upstream(),
      sentinel = await upstream(),
      material = signingMaterial();
    const proxy = owner.acquire(
      'owned TLS proxy',
      await createSamlAppProxy({
        origin: 'https://127.0.0.1:0',
        apiOrigin: api.origin,
        webOrigin: web.origin,
        material,
      }),
      (value) => value.close(),
    );
    expect(
      (await read(proxy.origin + '/v1/probe', material.certificate)).status,
    ).toBe(200);
    expect(
      (await read(proxy.origin + '/expected', material.certificate)).status,
    ).toBe(200);
    for (const path of [
      sentinel.origin + '/canary',
      '//' + new URL(sentinel.origin).host + '/canary',
      '/\\' + new URL(sentinel.origin).host + '/canary',
    ])
      expect(
        (await read(proxy.origin, material.certificate, { path })).status,
      ).toBe(400);
    expect(api.paths).toEqual(['/v1/probe']);
    expect(web.paths).toEqual(['/expected']);
    expect(sentinel.paths).toEqual([]);
  });
  it('renders canonical AuthnRequests and refuses reflected markup before rendering a form', async () => {
    const appOrigin = 'https://app.example.test';
    const idp = owner.acquire(
      'owned SAML IdP',
      await createBrowserSamlProvider(appOrigin),
      (value) => value.close(),
    );
    const metadata = samlServiceProviderMetadata(
      '11111111-1111-4111-8111-111111111111',
      appOrigin,
    );
    idp.registerMetadata(metadata);
    const url = new URL(
      await createSamlProofGateway().authorize(
        {
          id: '22222222-2222-4222-8222-222222222222',
          issuer: idp.configuration.issuer,
          configuration: {
            signInUrl: idp.configuration.signInUrl,
            certificates: [idp.configuration.certificate],
            emailAttribute: 'email',
            nameAttribute: 'name',
            jitEnabled: false,
          },
        },
        {
          ...metadata,
          requestId: '_owned_request',
          state: 's'.repeat(43),
          createdAt: new Date(),
        },
      ),
    );
    url.hostname = '127.0.0.1';
    const honest = await read(url, idp.material.certificate);
    expect(honest.status).toBe(200);
    expect(honest.body).toContain('Organization email');
    const encoded = url.searchParams.get('SAMLRequest') ?? '';
    for (const suffix of ['!', '" autofocus onfocus=alert(1) x="']) {
      url.searchParams.set('SAMLRequest', encoded + suffix);
      const invalid = await read(url, idp.material.certificate);
      expect(invalid.status).toBe(400);
      expect(invalid.body).not.toContain('autofocus');
      expect(invalid.body).not.toContain('<form');
    }
  });
});

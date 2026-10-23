import { createServer, type Server } from 'node:https';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { samlMetadataSchema } from '@pertexo/contracts';
import {
  signedResponse,
  signingMaterial,
} from '../../../authentication/federation/saml/fixture.js';

const assertion = 'urn:oasis:names:tc:SAML:2.0:assertion';
function escape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }),
  );
}
async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Owned TLS listener missing');
  return address.port;
}
/** Real Redirect/POST SAML across two sites. Only public metadata leaves the fixture. */
export async function createBrowserSamlProvider(appOrigin: string) {
  const material = signingMaterial();
  const callbackUri = new URL(
    '/v1/auth/federation/saml/callback',
    appOrigin,
  ).toString();
  const known = new Map<string, string>();
  let origin = '';
  const server = createServer(
    { key: material.privateKey, cert: material.certificate },
    (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url ?? '/', origin);
        if (incoming.method !== 'GET' || url.pathname !== '/sso') {
          outgoing.writeHead(404).end();
          return;
        }
        const { state, canonical, entityId, redirectUri, requestId } =
          readSamlRequest(url, origin, callbackUri, known);
        const email = url.searchParams.get('email');
        outgoing.setHeader('content-type', 'text/html; charset=utf-8');
        outgoing.setHeader('cache-control', 'no-store');
        if (email === null) {
          outgoing.end(
            `<main><h1>Local SAML provider</h1><form method="get"><input type="hidden" name="SAMLRequest" value="${canonical}"><input type="hidden" name="RelayState" value="${escape(state)}"><label>Organization email<input name="email" type="email" required></label><button>Verify SAML identity</button></form></main>`,
          );
          return;
        }
        if (
          !/^[a-zA-Z0-9@._+-]{1,320}$/u.test(email) ||
          !email.endsWith('.integration.test')
        )
          throw new Error('Unowned identity');
        const response = signedResponse(
          material,
          {
            id: '11111111-1111-4111-8111-111111111111',
            issuer: 'urn:pertexo:owned-browser-idp',
            configuration: {
              signInUrl: origin + '/sso',
              certificates: [material.certificate],
              emailAttribute: 'email',
              nameAttribute: 'name',
              jitEnabled: true,
            },
          },
          { entityId, redirectUri, requestId, state, createdAt: new Date() },
          { email, subject: email },
        );
        outgoing.end(
          `<main><form id="proof" method="post" action="${escape(callbackUri)}"><input type="hidden" name="SAMLResponse" value="${escape(response)}"><input type="hidden" name="RelayState" value="${escape(state)}"><button>Continue to Pertexo</button></form><script>document.getElementById('proof').submit()</script></main>`,
        );
      } catch {
        outgoing.writeHead(400).end('Invalid owned SAML request');
      }
    },
  );
  origin = `https://localhost:${String(await listen(server, 0))}`;
  return {
    material,
    configuration: {
      issuer: 'urn:pertexo:owned-browser-idp',
      signInUrl: origin + '/sso',
      certificate: material.certificate,
    },
    registerMetadata(value: unknown) {
      const metadata = samlMetadataSchema.parse(value);
      const document = new DOMParser().parseFromString(
          metadata.xml,
          'application/xml',
        ),
        root = document.documentElement;
      const endpoint = root.getElementsByTagNameNS(
        'urn:oasis:names:tc:SAML:2.0:metadata',
        'AssertionConsumerService',
      )[0];
      if (
        root.getAttribute('entityID') !== metadata.entityId ||
        endpoint?.getAttribute('Location') !== metadata.redirectUri ||
        metadata.redirectUri !== callbackUri
      )
        throw new Error('Metadata mismatch');
      known.set(metadata.entityId, metadata.redirectUri);
    },
    close: () => close(server),
  };
}
export async function createSamlAppProxy(
  input: Readonly<{
    origin: string;
    apiOrigin: string;
    webOrigin: string;
    material: ReturnType<typeof signingMaterial>;
  }>,
) {
  const proofs: { purpose: boolean; ordinary: boolean }[] = [];
  const server = createServer(
    { key: input.material.privateKey, cert: input.material.certificate },
    (incoming: IncomingMessage, outgoing: ServerResponse) => {
      const path = incoming.url ?? '/';
      if (
        !path.startsWith('/') ||
        path.startsWith('//') ||
        path.includes('\\')
      ) {
        outgoing.writeHead(400).end();
        return;
      }
      if (
        incoming.method === 'POST' &&
        path === '/v1/auth/federation/saml/callback'
      ) {
        const names = (incoming.headers.cookie ?? '')
          .split(';')
          .map((part) => part.trim().split('=', 1)[0]);
        proofs.push({
          purpose: names.includes('__Host-pertexo_organization_saml'),
          ordinary:
            names.includes('pertexo_session') || names.includes('pertexo_csrf'),
        });
      }
      const target = new URL(
        path.startsWith('/v1/') ? input.apiOrigin : input.webOrigin,
      );
      const upstream = request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
          outgoing.once('close', () => response.destroy());
        },
      );
      upstream.once('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.once('aborted', () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  const port = await listen(server, Number(new URL(input.origin).port));
  return {
    origin: `https://127.0.0.1:${String(port)}`,
    proofs,
    close: () => close(server),
  };
}

function readSamlRequest(
  url: URL,
  origin: string,
  callbackUri: string,
  known: ReadonlyMap<string, string>,
) {
  const encoded = url.searchParams.get('SAMLRequest') ?? '',
    state = url.searchParams.get('RelayState') ?? '';
  if (encoded.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    throw new Error('Invalid request encoding');
  const requestBytes = Buffer.from(encoded, 'base64'),
    canonical = requestBytes.toString('base64');
  if (canonical !== encoded) throw new Error('Ambiguous request encoding');
  const xml = inflateRawSync(requestBytes, {
    maxOutputLength: 65536,
  }).toString();
  const document = new DOMParser().parseFromString(xml, 'application/xml'),
    root = document.documentElement;
  const entityId =
      root.getElementsByTagNameNS(assertion, 'Issuer')[0]?.textContent ?? '',
    redirectUri = root.getAttribute('AssertionConsumerServiceURL') ?? '',
    requestId = root.getAttribute('ID') ?? '';
  if (
    root.localName !== 'AuthnRequest' ||
    root.getAttribute('Destination') !== origin + '/sso' ||
    known.get(entityId) !== redirectUri ||
    redirectUri !== callbackUri ||
    !/^_[a-zA-Z0-9_-]+$/u.test(requestId) ||
    !/^[a-zA-Z0-9_-]{43}$/u.test(state)
  )
    throw new Error('Unregistered AuthnRequest');

  return { state, canonical, entityId, redirectUri, requestId };
}

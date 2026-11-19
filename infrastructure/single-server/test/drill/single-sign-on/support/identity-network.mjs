import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { RUNTIME_IMAGE } from '../../support/images.mjs';
import { PUBLIC_HOSTS } from '../../support/overlay.mjs';
import { docker, mustDocker, waitFor } from '../../support/process.mjs';

// The internet the identity providers live on, on one Linux runner: a Docker
// network on an ordinary public range (Pertexo refuses provider addresses in
// private or documentation ranges), a DNS server the API asks for provider
// names and domain-verification TXT records, and one TLS edge in front of the
// providers, as self-hosters run them behind a reverse proxy. Its certificate
// authority is trusted by the server the way a public CA is.
export const NETWORK = {
  name: 'pertexo-sim-identity',
  subnet: '11.42.0.0/24',
  /** The host's address on the network: where the server publishes 80 and 443. */
  server: '11.42.0.1',
  edge: '11.42.0.10',
  dns: '11.42.0.53',
};
export const IDP_HOSTS = {
  keycloak: 'keycloak.idp.test',
  authentik: 'authentik.idp.test',
};
const CADDY =
  'caddy:2.11.8-alpine@sha256:f6228111e5fafa1a5238258d0858e103f10599b8d1659a146e7726681a002bb9';
const COREDNS =
  'coredns/coredns:1.13.1@sha256:9b9128672209474da07c91439bf15ed704ae05ad918dd6454e5b6ae14e35fee6';
const containers = { dns: 'pertexo-sim-dns', edge: 'pertexo-sim-idp-edge' };

/** The API joins the providers' network and asks its DNS; the proxy publishes on it. */
export function overlayIdentityCompose(text) {
  const compose = parse(text, { merge: true, maxAliasCount: -1 });
  compose.networks.identity = { external: true, name: NETWORK.name };
  compose.services.api.networks = ['private', 'identity'];
  compose.services.api.dns = [NETWORK.dns];
  compose.services.proxy.ports = [
    `${NETWORK.server}:80:80`,
    `${NETWORK.server}:443:443`,
  ];
  return stringify(compose, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/**
 * Creates the network, its DNS and a certificate authority. Call `startEdge`
 * with each provider host's upstream (container:port) once those exist.
 */
export async function openIdentityNetwork() {
  await closeIdentityNetwork();
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-identity-'));
  // CoreDNS and Caddy run unprivileged: they must be able to read it.
  chmodSync(directory, 0o755);
  const authority = createAuthority(directory);
  await mustDocker([
    'network',
    'create',
    '--subnet',
    NETWORK.subnet,
    '--gateway',
    NETWORK.server,
    NETWORK.name,
  ]);
  const zone = createZone(directory);
  await mustDocker([
    'run',
    '--detach',
    '--name',
    containers.dns,
    '--network',
    NETWORK.name,
    '--ip',
    NETWORK.dns,
    '--volume',
    `${directory}:/config:ro`,
    COREDNS,
    '-conf',
    '/config/Corefile',
  ]);
  return {
    directory,
    /** PEM of the authority every provider certificate chains to. */
    authority: authority.certificate,
    /** Publishes or replaces a TXT record, as a DNS provider's console does. */
    publishTxt: (name, value) => zone.publishTxt(name, value),
    startEdge: (upstreams) => startEdge(directory, upstreams),
    /** One HTTPS call to a provider, as a client on the internet makes it. */
    request: (url, options) =>
      providerRequest(url, { ...options, ca: authority.certificate }),
  };
}

export async function closeIdentityNetwork() {
  await docker(['rm', '--force', containers.dns, containers.edge]);
  await docker(['network', 'rm', NETWORK.name]);
}

function createAuthority(directory) {
  const path = (name) => join(directory, name);
  const openssl = (args) => execFileSync('openssl', args, { stdio: 'pipe' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-keyout',
    path('authority.key'),
    '-out',
    path('authority.pem'),
    '-subj',
    '/CN=pertexo-sim-identity-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path('edge.key'),
    '-out',
    path('edge.csr'),
    '-subj',
    `/CN=${IDP_HOSTS.keycloak}`,
  ]);
  writeFileSync(
    path('edge.ext'),
    `subjectAltName=${Object.values(IDP_HOSTS)
      .map((host) => `DNS:${host}`)
      .join(',')}\nextendedKeyUsage=serverAuth\n`,
  );
  openssl([
    'x509',
    '-req',
    '-in',
    path('edge.csr'),
    '-CA',
    path('authority.pem'),
    '-CAkey',
    path('authority.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-out',
    path('edge.crt'),
    '-extfile',
    path('edge.ext'),
  ]);
  chmodSync(path('edge.key'), 0o644);
  return {
    certificate: readFileSync(path('authority.pem'), 'utf8'),
  };
}

function createZone(directory) {
  const records = new Map();
  let serial = 1;
  const write = () => {
    const lines = [
      '$ORIGIN test.',
      `@ 60 IN SOA ns.test. hostmaster.test. ${serial} 60 60 600 5`,
      '@ 60 IN NS ns.test.',
      `ns 60 IN A ${NETWORK.dns}`,
      `${PUBLIC_HOSTS.app}. 60 IN A ${NETWORK.server}`,
      ...Object.values(IDP_HOSTS).map(
        (host) => `${host}. 60 IN A ${NETWORK.edge}`,
      ),
      ...[...records].map(
        ([name, value]) => `${name}. 5 IN TXT ${JSON.stringify(value)}`,
      ),
    ];
    serial += 1;
    // A rename, so CoreDNS never reads half a file.
    writeFileSync(join(directory, 'zone.next'), `${lines.join('\n')}\n`);
    renameSync(join(directory, 'zone.next'), join(directory, 'test.zone'));
  };
  writeFileSync(
    join(directory, 'Corefile'),
    `test:53 {\n  file /config/test.zone {\n    reload 1s\n  }\n  log\n  errors\n}\n`,
  );
  write();
  return {
    publishTxt: async (name, value) => {
      records.set(name, value);
      write();
      // The API asks again only after CoreDNS has reloaded the zone.
      await waitFor(
        async () => {
          const answer = await docker([
            'run',
            '--rm',
            '--network',
            NETWORK.name,
            '--dns',
            NETWORK.dns,
            '--entrypoint',
            'node',
            RUNTIME_IMAGE,
            '-e',
            `require('node:dns').promises.resolveTxt(${JSON.stringify(name)}).then((r) => console.log(JSON.stringify(r)), () => console.log('[]'))`,
          ]);
          return answer.stdout.includes(value);
        },
        { what: `the TXT record for ${name}`, timeout: 30_000, every: 1_000 },
      );
    },
  };
}

async function startEdge(directory, upstreams) {
  const sites = Object.entries(upstreams)
    .map(
      ([host, upstream]) =>
        `${host}:443 {\n\ttls /config/edge.crt /config/edge.key\n\treverse_proxy ${upstream}\n}\n`,
    )
    .join('\n');
  writeFileSync(
    join(directory, 'Caddyfile'),
    `{\n\tadmin off\n\tauto_https off\n}\n${sites}`,
  );
  await mustDocker([
    'run',
    '--detach',
    '--name',
    containers.edge,
    '--network',
    NETWORK.name,
    '--ip',
    NETWORK.edge,
    '--volume',
    `${directory}:/config:ro`,
    CADDY,
    'caddy',
    'run',
    '--config',
    '/config/Caddyfile',
  ]);
}

/**
 * JSON or text over HTTPS to a provider's public name, trusting only the
 * simulation's authority. Returns status, headers, text and parsed JSON.
 */
export function providerRequest(
  url,
  { method = 'GET', headers = {}, body, form, ca, timeout = 30_000 } = {},
) {
  const target = new URL(url);
  const payload =
    form !== undefined
      ? new URLSearchParams(form).toString()
      : body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
  const contentType =
    form !== undefined
      ? 'application/x-www-form-urlencoded'
      : typeof body === 'string'
        ? 'text/plain'
        : 'application/json';
  return new Promise((resolve, reject) => {
    const sent = httpsRequest(
      {
        host: NETWORK.edge,
        port: 443,
        servername: target.hostname,
        ca,
        method,
        path: target.pathname + target.search,
        headers: {
          host: target.host,
          accept: 'application/json',
          ...(payload === undefined
            ? {}
            : {
                'content-type': contentType,
                'content-length': Buffer.byteLength(payload),
              }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            // Metadata and pages aren't JSON.
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
            json,
          });
        });
      },
    );
    sent.setTimeout(timeout, () =>
      sent.destroy(new Error(`${method} ${url} timed out`)),
    );
    sent.once('error', reject);
    sent.end(payload);
  });
}

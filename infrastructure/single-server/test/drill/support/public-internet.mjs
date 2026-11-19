import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_IMAGE } from './images.mjs';
import { OUTSIDE_REQUEST } from './outside-request.mjs';
import { PUBLIC_HOSTS } from './overlay.mjs';
import { docker, must, mustDocker, waitFor } from './process.mjs';

// The outside world a self-hosted server lives in, on one Linux runner: public
// names from CoreDNS, certificates from Pebble (a real ACME authority), and a
// sender on its own network that reaches the server the way the internet does,
// through the host's published ports with its own source address. Needs root on
// the host (sudo) for the link and the firewall; GitHub's Linux runners have it.
export const INTERNET = {
  /** The server's public address, on the host side of the outside link. */
  server: '198.51.100.1',
  /** An outside sender's address: what the app should see as its client. */
  sender: '198.51.100.2',
};
const LINK = 'pxo-wan';
/** Where the server finds its certificate authority, as public DNS would say. */
export const AUTHORITY = { name: 'pebble', port: 14000 };
const PEBBLE_PORT = AUTHORITY.port;
const PEBBLE_MANAGEMENT_PORT = 15000;
/** Let's Encrypt's usual lifetime, unless a scenario wants to watch renewal. */
const CERTIFICATE_SECONDS = 90 * 24 * 60 * 60;
const PEBBLE =
  'ghcr.io/letsencrypt/pebble:2.9.0@sha256:8df2a35c8ca5aba9777f3b47ce0afc4181ad43c3031838aed463eb8fda83c8bb';
const COREDNS =
  'coredns/coredns:1.13.1@sha256:9b9128672209474da07c91439bf15ed704ae05ad918dd6454e5b6ae14e35fee6';
const names = {
  pebble: 'pertexo-sim-pebble',
  dns: 'pertexo-sim-dns',
  sender: 'pertexo-sim-sender',
};

const sudo = (args, options) => must('sudo', args, options);

/** Starts DNS, the certificate authority and an outside sender. */
export async function openInternet({
  certificateSeconds = CERTIFICATE_SECONDS,
} = {}) {
  await closeInternet();
  await sudo([
    'ip',
    'link',
    'add',
    LINK,
    'type',
    'veth',
    'peer',
    'name',
    `${LINK}-peer`,
  ]);
  await sudo(['ip', 'address', 'add', `${INTERNET.server}/24`, 'dev', LINK]);
  await sudo(['ip', 'link', 'set', LINK, 'up']);

  const configuration = mkdtempSync(join(tmpdir(), 'pertexo-internet-'));
  // CoreDNS and Pebble run as unprivileged users: they must be able to read it.
  chmodSync(configuration, 0o755);
  writeFileSync(
    join(configuration, 'Corefile'),
    `.:53 {\n  bind ${INTERNET.server}\n  hosts {\n    ${INTERNET.server} ${PUBLIC_HOSTS.app} ${PUBLIC_HOSTS.files}\n  }\n  log\n}\n`,
  );
  await mustDocker([
    'run',
    '--detach',
    '--name',
    names.dns,
    '--network',
    'host',
    '--volume',
    `${configuration}:/config:ro`,
    COREDNS,
    '-conf',
    '/config/Corefile',
  ]);

  const pebbleConfig = JSON.stringify({
    pebble: {
      listenAddress: `0.0.0.0:${PEBBLE_PORT}`,
      managementListenAddress: `0.0.0.0:${PEBBLE_MANAGEMENT_PORT}`,
      certificate: '/test/certs/localhost/cert.pem',
      privateKey: '/test/certs/localhost/key.pem',
      httpPort: 80,
      tlsPort: 443,
      ocspResponderURL: '',
      externalAccountBindingRequired: false,
      retryAfter: { authz: 3, order: 5 },
      profiles: {
        default: {
          description: 'Short-lived',
          validityPeriod: certificateSeconds,
        },
      },
    },
  });
  writeFileSync(join(configuration, 'pebble.json'), pebbleConfig);
  await mustDocker([
    'run',
    '--detach',
    '--name',
    names.pebble,
    '--network',
    'host',
    // Validation is immediate and always real: no random sleeps, no shortcuts.
    '--env',
    'PEBBLE_VA_NOSLEEP=1',
    '--volume',
    `${configuration}:/config:ro`,
    PEBBLE,
    '-config',
    '/config/pebble.json',
    '-dnsserver',
    `${INTERNET.server}:53`,
  ]);
  const minica = await copyOut(names.pebble, '/test/certs/pebble.minica.pem');
  const root = await waitFor(
    async () => {
      const response = await fetchPebble('/roots/0', minica);
      return response.startsWith('-----BEGIN CERTIFICATE-----') && response;
    },
    { what: 'Pebble to serve its root', timeout: 60_000 },
  );

  await mustDocker([
    'run',
    '--detach',
    '--name',
    names.sender,
    '--network',
    'none',
    '--dns',
    INTERNET.server,
    '--entrypoint',
    'sleep',
    RUNTIME_IMAGE,
    'infinity',
  ]);
  const pid = await mustDocker([
    'inspect',
    '--format',
    '{{.State.Pid}}',
    names.sender,
  ]);
  await sudo(['ip', 'link', 'set', `${LINK}-peer`, 'netns', pid]);
  const inSender = (args) =>
    sudo(['nsenter', '--target', pid, '--net', ...args]);
  await inSender([
    'ip',
    'address',
    'add',
    `${INTERNET.sender}/24`,
    'dev',
    `${LINK}-peer`,
  ]);
  await inSender(['ip', 'link', 'set', `${LINK}-peer`, 'up']);
  await inSender(['ip', 'route', 'add', 'default', 'via', INTERNET.server]);
  await mustDocker(
    [
      'exec',
      '--user',
      '0',
      '-i',
      names.sender,
      'sh',
      '-c',
      'cat > /tmp/root.pem',
    ],
    {
      input: root,
    },
  );

  return {
    /** Pebble's issuing root: what a browser would already trust. */
    root,
    /** The CA for Pebble's own ACME address, which Caddy must trust. */
    minica,
    /** Makes the certificate authority unreachable from the server. */
    blockAuthority: () =>
      sudo([
        'iptables',
        '-I',
        'INPUT',
        '-p',
        'tcp',
        '--dport',
        String(PEBBLE_PORT),
        '-j',
        'REJECT',
        '--reject-with',
        'tcp-reset',
      ]),
    unblockAuthority: () =>
      sudo([
        'iptables',
        '-D',
        'INPUT',
        '-p',
        'tcp',
        '--dport',
        String(PEBBLE_PORT),
        '-j',
        'REJECT',
        '--reject-with',
        'tcp-reset',
      ]),
    /** One HTTP(S) request from the outside sender; see outside-request.mjs. */
    request: async (input) => {
      const result = await docker(
        [
          'exec',
          '-i',
          '--env',
          `SENDER_INPUT=${JSON.stringify(input)}`,
          '--env',
          'NODE_EXTRA_CA_CERTS=/tmp/root.pem',
          names.sender,
          'node',
          '--input-type=module',
          '-',
        ],
        { input: OUTSIDE_REQUEST, timeout: 300_000 },
      );
      if (result.status !== 0)
        throw new Error(
          `The sender failed\n${result.stdout}\n${result.stderr}`,
        );
      return JSON.parse(result.stdout.trim().split('\n').at(-1));
    },
    /** What DNS answered, as the outside sees it. */
    resolve: (name) =>
      mustDocker([
        'exec',
        names.sender,
        'node',
        '-e',
        `require('node:dns').promises.lookup(${JSON.stringify(name)}).then((a) => console.log(a.address))`,
      ]),
    certificateLog: () => mustDocker(['logs', names.pebble]).catch(() => ''),
  };
}

export async function closeInternet() {
  await docker(['rm', '--force', names.dns, names.pebble, names.sender]);
  await sudo(['ip', 'link', 'delete', LINK]).catch(() => undefined);
  await must('sudo', [
    'iptables',
    '-D',
    'INPUT',
    '-p',
    'tcp',
    '--dport',
    String(PEBBLE_PORT),
    '-j',
    'REJECT',
    '--reject-with',
    'tcp-reset',
  ]).catch(() => undefined);
}

async function copyOut(container, path) {
  const archive = await docker(['cp', `${container}:${path}`, '-']);
  if (archive.status !== 0) throw new Error(archive.stderr);
  const start = archive.stdout.indexOf('-----BEGIN');
  const end =
    archive.stdout.indexOf('-----END CERTIFICATE-----') +
    '-----END CERTIFICATE-----'.length;
  return `${archive.stdout.slice(start, end)}\n`;
}

async function fetchPebble(path, ca) {
  const { request } = await import('node:https');
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: '127.0.0.1',
        port: PEBBLE_MANAGEMENT_PORT,
        path,
        ca,
        servername: 'localhost',
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    sent.once('error', reject);
    sent.end();
  });
}

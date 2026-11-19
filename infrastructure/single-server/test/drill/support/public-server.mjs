import { parse, stringify } from 'yaml';
import { createClient } from './client.mjs';
import { RUNTIME_IMAGE } from './images.mjs';
import { PUBLIC_HOSTS } from './overlay.mjs';
import { docker, mustDocker, waitFor } from './process.mjs';
import { AUTHORITY, INTERNET } from './public-internet.mjs';
import { signIn, signUp } from './product.mjs';
import { configure, createServer, project } from './server.mjs';

// A server set up the way the runbook says, on the simulated public internet:
// Caddy takes its certificates from the ACME authority, the proxy publishes the
// production ports, and the operator's optional telemetry collector is running.
// Built on the drill's server; only the overlays below differ from it.
const COLLECTOR =
  'otel/opentelemetry-collector:0.140.0@sha256:6852803128c97a37fd2bafb989a04a10e3af920737d8eee998eefdfcebc698be';
export const TELEMETRY_HOST = 'telemetry.drill.test';
const COLLECTOR_CONFIG = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;

/** Caddy gets its certificates from the authority the production way: ACME. */
export function overlayAcmeCaddyfile(source) {
  const replaced = source.replace(
    /^\{\n\tadmin off\n/u,
    `{\n\tadmin off\n\tacme_ca https://${AUTHORITY.name}:${AUTHORITY.port}/dir\n\tacme_ca_root /drill-tls/authority.pem\n\temail operator@drill.test\n\t# Every 10 minutes by default: too slow for a certificate that lives minutes.\n\trenew_interval 15s\n`,
  );
  if (replaced === source)
    throw new Error('The ACME overlay no longer matches the Caddyfile');
  return replaced;
}

/** The production ports, the authority's public address and a collector. */
export function overlayPublicCompose(text, { storageDirectory } = {}) {
  const compose = parse(text, { merge: true, maxAliasCount: -1 });
  // A disk of its own lets a scenario fill the store the way a real disk fills.
  if (storageDirectory)
    compose.volumes['storage-data'] = {
      driver: 'local',
      driver_opts: { type: 'none', o: 'bind', device: storageDirectory },
    };
  compose.services.proxy.ports = ['80:80', '443:443'];
  compose.services.proxy.extra_hosts = [`${AUTHORITY.name}:${INTERNET.server}`];
  compose.services['drill-telemetry'] = {
    image: COLLECTOR,
    restart: 'unless-stopped',
    command: ['--config=/drill-tls/collector.yaml'],
    volumes: ['${BETA_STATE_DIR}/../drill-tls:/drill-tls:ro'],
    networks: { private: { aliases: [TELEMETRY_HOST] } },
  };
  compose.services.storage.depends_on.push('drill-telemetry');
  // Lets a scenario make the relay refuse, the way a provider sometimes does.
  compose.services['drill-mail'].environment.MP_ENABLE_CHAOS = 'true';
  return stringify(compose, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/**
 * A fresh server with its settings written, trusting the authority as a real
 * server trusts public CAs. `settings` adds or replaces .env.production lines;
 * `storageDirectory` puts the file store on that host directory.
 */
export async function createPublicServer(
  internet,
  { settings = {}, storageDirectory } = {},
) {
  const server = await createServer({
    caddyfile: overlayAcmeCaddyfile,
    compose: (text) => overlayPublicCompose(text, { storageDirectory }),
  });
  await configure(server);
  await server.mustExec('cat > drill-tls/authority.pem', {
    input: internet.minica,
  });
  await server.mustExec('cat > drill-tls/collector.yaml', {
    input: COLLECTOR_CONFIG,
  });
  // Containers trust the issued root the way a server trusts Let's Encrypt's.
  await server.mustExec('cat >> drill-tls/ca.crt', { input: internet.root });
  await setSettings(server, {
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://${TELEMETRY_HOST}:4318`,
    ...settings,
  });
  return server;
}

/** Replaces or adds .env.production lines, as an operator's editor does. */
export async function setSettings(server, settings) {
  for (const [key, value] of Object.entries(settings))
    await server.mustExec(
      `{ grep -v '^${key}=' .env.production || true; } > .env.next; ${
        value === undefined ? '' : `printf '%s\\n' "$VALUE" >> .env.next; `
      }cat .env.next > .env.production; rm .env.next`,
      { env: { VALUE: `${key}=${value}` } },
    );
}

/** A browser on the internet: public names, public certificates. */
export const publicClient = (internet) =>
  createClient({
    origin: `https://${PUBLIC_HOSTS.app}`,
    connect: { host: INTERNET.server, port: 443 },
    ca: internet.root,
  });

/** Mail the relay accepted, newest first, as Mailpit's API lists it. */
export async function mailbox(server, path = 'messages') {
  return JSON.parse(
    await mustDocker([
      'exec',
      await server.containerOf('drill-mail'),
      'wget',
      '-qO-',
      `http://127.0.0.1:8025/api/v1/${path}`,
    ]),
  );
}

/** Sets how the relay misbehaves; see Mailpit's chaos API. `{}` restores it. */
export async function setRelayFaults(server, faults) {
  const script = `fetch('http://${PUBLIC_HOSTS.mail}:8025/api/v1/chaos', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: process.env.FAULTS }).then(async (response) => { if (!response.ok) throw new Error(response.status + ' ' + (await response.text())); })`;
  await mustDocker([
    'run',
    '--rm',
    '--network',
    `${project}_private`,
    '--env',
    `FAULTS=${JSON.stringify(faults)}`,
    '--entrypoint',
    'node',
    RUNTIME_IMAGE,
    '-e',
    script,
  ]);
}

/** Waits for a message to `address` whose subject matches, and returns it in full. */
export async function waitForMail(server, address, subject, timeout = 60_000) {
  const summary = await waitFor(
    async () =>
      (await mailbox(server)).messages.find(
        (message) =>
          message.To.some((to) => to.Address === address) &&
          subject.test(message.Subject),
      ),
    { what: `mail to ${address} matching ${subject}`, timeout },
  );
  const full = await mailbox(server, `message/${summary.ID}`);
  const headers = await mailbox(server, `message/${summary.ID}/headers`);
  return { ...full, headers };
}

/** Links in a message's text, in order. */
export const linksIn = (message) => [
  ...new Set(message.Text.match(/https?:\/\/[^\s<>"')\]]+/gu) ?? []),
];

/** Signs the first person up, verifies the address from the mail and signs in. */
export async function createOwner(server, client, person) {
  const signedUp = await signUp(client, person);
  if (signedUp.status !== 200)
    throw new Error(`Sign-up failed: ${signedUp.status} ${signedUp.text}`);
  const mail = await waitForMail(server, person.email, /verif|confirm/iu);
  const link = linksIn(mail).find((url) => /verify/iu.test(url));
  const opened = await client.get(link);
  if (opened.status >= 400)
    throw new Error(`Verification failed: ${opened.status} ${opened.text}`);
  const signedIn = await signIn(client, person);
  if (signedIn.status !== 200)
    throw new Error(`Sign-in failed: ${signedIn.status} ${signedIn.text}`);
  return { mail, link, signedIn };
}

/** Spans the collector received: service, trace, name and string attributes. */
export async function receivedSpans(server) {
  // The debug exporter writes to standard error.
  const { stdout, stderr } = await docker([
    'logs',
    await server.containerOf('drill-telemetry'),
  ]);
  const spans = [];
  for (const block of (stdout + stderr).split(/ResourceSpans #\d+/u).slice(1)) {
    const service = /service\.name: Str\(([^)]+)\)/u.exec(block)?.[1];
    for (const part of block.split(/\n\s*Span #\d+/u).slice(1)) {
      const traceId = /Trace ID\s*: ([0-9a-f]{32})/u.exec(part)?.[1];
      const name = /\n\s*Name\s*: ([^\n]+)/u.exec(part)?.[1]?.trim();
      const attributes = Object.fromEntries(
        [...part.matchAll(/-> ([\w.]+): \w+\(([^)\n]*)\)/gu)].map((match) => [
          match[1],
          match[2],
        ]),
      );
      if (traceId) spans.push({ service, traceId, name, attributes });
    }
  }
  return spans;
}

/** SQL as the database superuser, through the release's own Compose project. */
export async function sql(server, query) {
  const result = await server.composeFor(await server.current(), [
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"',
    '--',
    query,
  ]);
  if (result.status !== 0) throw new Error(`${query}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Compose for the current release; fails on a non-zero exit. */
export async function compose(server, args, options) {
  const result = await server.composeFor(await server.current(), args, options);
  if (result.status !== 0)
    throw new Error(
      `compose ${args.join(' ')}: ${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

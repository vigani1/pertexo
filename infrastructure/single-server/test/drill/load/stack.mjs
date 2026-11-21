import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { createClient } from '../support/client.mjs';
import { RUNTIME_IMAGE } from '../support/images.mjs';
import { PUBLIC_HOSTS } from '../support/overlay.mjs';
import { docker, mustDocker, waitFor } from '../support/process.mjs';
import { signIn, signUp } from '../support/product.mjs';
import { configure, createServer, httpsPort } from '../support/server.mjs';
import { TARGET_SOURCE } from './target.mjs';

// The production stack at the documented minimum size, one of two ways:
// - `host` (the default): the server the runbook asks for, 4 GiB and 2 vCPUs.
//   Every service keeps production's own settings and runs inside one cgroup
//   with that memory, no swap and that CPU quota, which the caller creates and
//   names in LOAD_HOST_CGROUP_PARENT (the workflow makes a systemd slice).
// - `j1`: the J1 qualification's per-service caps
//   (docs/operations/single-server.md), 4 GiB and 2 vCPUs in all, memory+swap
//   equal to memory. The Code runner keeps what storage/prepare.mjs gives it.
// The drill's stand-ins and the load target are the outside world: uncapped.
export const SIZING = process.env.LOAD_SIZING ?? 'host';
export const HOST_SIZE = Object.freeze({ memoryMiB: 4_096, cpus: 2 });
export const J1_CAPS = Object.freeze({
  api: { memoryMiB: 512, cpus: 0.5 },
  worker: { memoryMiB: 512, cpus: 0.3 },
  'code-runner': { cpus: 0.5 },
  postgres: { memoryMiB: 256, cpus: 0.2 },
  redis: { memoryMiB: 128, cpus: 0.05 },
  storage: { memoryMiB: 256, cpus: 0.05 },
  web: { memoryMiB: 32, cpus: 0.05 },
  proxy: { memoryMiB: 32, cpus: 0.05 },
  migration: { memoryMiB: 240, cpus: 0.15 },
  ops: { memoryMiB: 256, cpus: 0.15 },
});
/** The services that serve users; the stand-ins and the target are not ours. */
export const SERVING_SERVICES = Object.freeze(
  Object.keys(J1_CAPS).filter(
    (service) => service !== 'migration' && service !== 'ops',
  ),
);
// A fixed address, so the operator can allow exactly it for plain-http steps.
const TARGET_ADDRESS = '172.30.42.250';
export const TARGET_ORIGIN = 'http://target.drill.test:8080';

export function overlayMinimumSize(text) {
  const compose = parse(text, { merge: true, maxAliasCount: -1 });
  if (SIZING === 'host') {
    const parent = process.env.LOAD_HOST_CGROUP_PARENT;
    assert.ok(parent, 'LOAD_HOST_CGROUP_PARENT names the 4 GiB host cgroup');
    for (const name of Object.keys(J1_CAPS))
      compose.services[name].cgroup_parent = parent;
  } else {
    assert.equal(SIZING, 'j1', `unknown LOAD_SIZING ${SIZING}`);
    for (const [name, { memoryMiB, cpus }] of Object.entries(J1_CAPS)) {
      const service = compose.services[name];
      if (memoryMiB !== undefined) {
        service.mem_limit = `${memoryMiB}m`;
        service.memswap_limit = `${memoryMiB}m`;
      }
      service.cpus = String(cpus);
    }
  }
  compose.services.worker.environment.WORKFLOW_COORDINATOR_INLINE_STEPS =
    process.env.WORKFLOW_COORDINATOR_INLINE_STEPS ?? 'false';
  compose.services['drill-target'] = {
    image: RUNTIME_IMAGE,
    restart: 'unless-stopped',
    command: ['node', '-e', TARGET_SOURCE],
    environment: { NODE_EXTRA_CA_CERTS: '/drill-tls/ca.crt' },
    volumes: ['${BETA_STATE_DIR}/../drill-tls:/drill-tls:ro'],
    networks: {
      private: {
        ipv4_address: TARGET_ADDRESS,
        aliases: ['target.drill.test'],
      },
    },
  };
  compose.services.storage.depends_on.push('drill-target');
  return stringify(compose, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/**
 * Deploys the first release at the minimum size, signs the owner up and in,
 * and returns the server and a browser-like client for the owner.
 */
export async function deployMinimumServer() {
  const server = await createServer({ compose: overlayMinimumSize });
  await configure(server);
  await server.mustExec(
    `printf 'HTTP_ALLOWED_PRIVATE_NETWORKS=${TARGET_ADDRESS}/32\\n' >> .env.production`,
  );
  const deployed = await server.script('deploy.sh', [server.releases.first]);
  assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
  const owner = {
    email: `load-${randomUUID().slice(0, 8)}@drill.test`,
    password: 'correct-horse-battery-staple-7',
    name: 'Load Owner',
  };
  const client = browser(server);
  assert.equal((await signUp(client, owner)).status, 200);
  const link = await waitFor(
    async () => {
      const listed = await mail(server, 'messages');
      const message = listed.messages.find((candidate) =>
        candidate.To.some((to) => to.Address === owner.email),
      );
      if (!message) return undefined;
      return /https:\/\/\S+verify\S*/u.exec(
        (await mail(server, `message/${message.ID}`)).Text,
      )?.[0];
    },
    { what: 'the verification mail', timeout: 60_000 },
  );
  assert.ok((await client.get(link)).status < 400);
  await signInPolitely(client, owner);
  return { server, client, owner };
}

/** Another browser tab or device of the same person: its own session. */
export async function signedInBrowser(server, owner) {
  const client = browser(server);
  await signInPolitely(client, owner);
  return client;
}

/** Signs in, waiting out the sign-in limit (10 a minute per address) as a person would. */
async function signInPolitely(client, owner) {
  for (let attempt = 0; ; attempt++) {
    const signed = await signIn(client, owner);
    if (signed.status !== 429 || attempt === 3) {
      assert.equal(signed.status, 200, signed.text);
      return;
    }
    const seconds = Number(signed.headers['retry-after'] ?? 60);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  }
}

const browser = (server) =>
  createClient({
    origin: `https://${PUBLIC_HOSTS.app}`,
    connect: { host: '127.0.0.1', port: httpsPort },
    ca: server.ca,
  });

async function mail(server, path) {
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

/** The host cgroup's memory now, at its peak, and its OOM kills, when sized as a host. */
export async function hostMemory() {
  const directory = process.env.LOAD_HOST_CGROUP_PATH;
  if (SIZING !== 'host' || !directory) return null;
  const read = (name) => readFile(`${directory}/${name}`, 'utf8');
  const events = Object.fromEntries(
    (await read('memory.events'))
      .trim()
      .split('\n')
      .map((line) => line.split(' ')),
  );
  const [peak, cpu] = await Promise.all([
    read('memory.peak').catch(() => null),
    read('cpu.stat'),
  ]);
  const cpuMicros = /^usage_usec (\d+)$/mu.exec(cpu)?.[1];
  return {
    currentMib: Math.round(Number(await read('memory.current')) / 1_048_576),
    peakMib: peak === null ? null : Math.round(Number(peak) / 1_048_576),
    cpuMicros: cpuMicros === undefined ? null : Number(cpuMicros),
    oomKills: Number(events.oom_kill ?? 0),
    highEvents: Number(events.high ?? 0),
    maxEvents: Number(events.max ?? 0),
  };
}

/** SQL as the database superuser, straight into the PostgreSQL container. */
export async function sql(server, query) {
  const result = await docker([
    'exec',
    await server.containerOf('postgres'),
    'sh',
    '-c',
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"',
    '--',
    query,
  ]);
  if (result.status !== 0) throw new Error(`${query}\n${result.stderr}`);
  return result.stdout.trim();
}

/** One row of JSON from a query that selects a single json value. */
export const sqlJson = async (server, query) =>
  JSON.parse((await sql(server, query)) || 'null');

/** What the load target saw: requests, failures it served and callbacks it sent. */
export async function targetCounts(server) {
  return JSON.parse(
    await mustDocker([
      'exec',
      await server.containerOf('drill-target'),
      'node',
      '-e',
      "fetch('http://127.0.0.1:8080/counts').then((r) => r.text()).then((t) => process.stdout.write(t))",
    ]),
  );
}

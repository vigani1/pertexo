import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe } from 'node:test';
import { it } from '../support/it.mjs';
import { RUNTIME_IMAGE, WEB_IMAGE, requireImages } from './support/images.mjs';
import { docker, mustDocker, waitFor } from './support/process.mjs';

// The real web image against a stand-in API, which is enough to see what nginx does
// when the API comes back somewhere else. stack.test.mjs covers the same outage
// through the real scripts; this one is quick and shows the cause.
const suffix = randomUUID().slice(0, 8);
const network = `pertexo-drill-proxy-${suffix}`;
const owned = [];
const API = `require('node:http').createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ path: request.url }));
}).listen(3000)`;

const start = async (args) => {
  const id = await mustDocker([
    'run',
    '--detach',
    '--network',
    network,
    ...args,
  ]);
  owned.push(id);
  return id;
};
const startApi = () =>
  start([
    '--network-alias',
    'api',
    '--read-only',
    '--entrypoint',
    'node',
    RUNTIME_IMAGE,
    '-e',
    API,
  ]);
const startWeb = async () => {
  const id = await start([
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/etc/nginx/conf.d:uid=101,gid=101,mode=0755',
    '--publish',
    '127.0.0.1::8080',
    WEB_IMAGE,
  ]);
  const port = (await mustDocker(['port', id, '8080/tcp'])).split(':').at(-1);
  return `http://127.0.0.1:${port}`;
};
const addressOf = (id) =>
  mustDocker([
    'inspect',
    '--format',
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    id,
  ]);
const statusOf = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  await response.arrayBuffer();
  return response.status;
};

describe('the web tier in front of the API', () => {
  before(async () => {
    await requireImages();
    await mustDocker([
      'network',
      'create',
      '--subnet',
      '172.30.43.0/24',
      network,
    ]);
  });
  // Each case needs `api` to mean only its own container.
  afterEach(async () => {
    if (owned.length) await docker(['rm', '--force', ...owned.splice(0)]);
  });
  after(async () => {
    await docker(['network', 'rm', network]);
  });

  it('passes API requests through', async () => {
    await startApi();
    const web = await startWeb();
    await waitFor(async () => (await statusOf(`${web}/v1/probe`)) === 200, {
      what: 'the web tier to reach the API',
      timeout: 30_000,
    });
  });

  // ops-01: nginx resolves `api` once, at startup. A backup or deploy stops the API
  // and not web; the API returns at another address and every signed-in request gets a
  // 502, while every health check stays green.
  it.fails(
    'finds the API again when it comes back at another address',
    async () => {
      const api = await startApi();
      const web = await startWeb();
      await waitFor(async () => (await statusOf(`${web}/v1/probe`)) === 200, {
        what: 'the web tier to reach the API',
        timeout: 30_000,
      });
      const oldAddress = await addressOf(api);
      await mustDocker(['stop', '--timeout', '1', api]);
      // Something else takes the old address, as backup helpers do on the real network.
      const holder = await start([
        '--ip',
        oldAddress,
        '--entrypoint',
        'sleep',
        RUNTIME_IMAGE,
        '300',
      ]);
      await mustDocker(['start', api]);
      assert.notEqual(await addressOf(api), oldAddress);
      await mustDocker(['rm', '--force', holder]);
      // Longer than any sane DNS validity, shorter than the audit's 7-minute outage.
      await waitFor(async () => (await statusOf(`${web}/v1/probe`)) === 200, {
        what: 'nginx to find the moved API',
        timeout: 20_000,
      });
    },
  );

  // ops-01: same cause. When Docker starts web before the API has a name, nginx exits.
  it.fails(
    'serves the app while the API is not up yet, then reaches it',
    async () => {
      await mustDocker(['network', 'create', `${network}-empty`]);
      let id;
      try {
        id = await mustDocker([
          'run',
          '--detach',
          '--network',
          `${network}-empty`,
          '--read-only',
          '--tmpfs',
          '/tmp',
          '--tmpfs',
          '/etc/nginx/conf.d:uid=101,gid=101,mode=0755',
          '--publish',
          '127.0.0.1::8080',
          WEB_IMAGE,
        ]);
        const port = (await mustDocker(['port', id, '8080/tcp']))
          .split(':')
          .at(-1);
        await waitFor(
          async () => (await statusOf(`http://127.0.0.1:${port}/`)) === 200,
          { what: 'the app page', timeout: 15_000 },
        );
      } finally {
        if (id) await docker(['rm', '--force', id]);
        await docker(['network', 'rm', `${network}-empty`]);
      }
    },
  );
});

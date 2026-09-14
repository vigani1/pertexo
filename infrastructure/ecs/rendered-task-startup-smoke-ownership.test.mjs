import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

import {
  acquireOwnedResource,
  closeServerResources,
  createContainerOwner,
  credentialUrl,
  preserveSmokeFailureDuringCleanup,
  readApiReadiness,
  renderedHealthCommand,
  runSmokeCommand,
  smokeRunIdentifier,
} from './rendered-task-startup-smoke-ownership.mjs';

test('startup smoke can be imported without acquiring resources', async () => {
  await assert.doesNotReject(
    import(`./rendered-task-startup-smoke.mjs?test=${String(Date.now())}`),
  );
});

test('partial TLS-style acquisition cleans its server and exact directory', async (t) => {
  const parent = await mkdtemp(resolve(tmpdir(), 'pertexo-smoke-owner-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const unrelated = resolve(parent, 'unrelated');
  let serverClosed = false;
  await acquireOwnedResource({
    acquireDirectory: async () => {
      await mkdir(unrelated, { recursive: true });
      return mkdtemp(resolve(parent, 'tls-'));
    },
    removeDirectory: (directory) =>
      rm(directory, { recursive: true, force: true }),
    acquire: async (owner) => {
      owner.registerCleanup(async () => {
        serverClosed = true;
      });
      throw new Error('TLS listen failed');
    },
  }).then(
    () => assert.fail('partial acquisition unexpectedly succeeded'),
    (error) => assert.match(error.message, /TLS listen failed/u),
  );
  const children = await readdir(parent);
  assert.equal(serverClosed, true);
  assert.deepEqual(children, ['unrelated']);
});

test('owned directory removal still runs when server cleanup fails', async () => {
  let directoryRemoved = false;
  const owned = await acquireOwnedResource({
    acquireDirectory: async () => '/controlled/tls',
    removeDirectory: async () => {
      directoryRemoved = true;
    },
    acquire: async (owner) => {
      owner.registerCleanup(async () => {
        throw new Error('server close failed');
      });
      return 'bridge';
    },
  });
  await assert.rejects(owned.close(), /server close failed/u);
  assert.equal(directoryRemoved, true);
});

test('a created-but-start-failed container remains owned by exact ID', async () => {
  const id = 'a'.repeat(64);
  const commands = [];
  const owner = createContainerOwner(async (args) => {
    commands.push(args);
    if (args[0] === 'create') return { stdout: `${id}\n` };
    if (args[0] === 'start') throw new Error('start failed');
    return { stdout: '' };
  });
  await assert.rejects(
    owner.createAndStart(['--name', 'unique']),
    /start failed/u,
  );
  assert.deepEqual(owner.ownedContainerIds(), [id]);
  await owner.close();
  assert.deepEqual(commands, [
    ['create', '--name', 'unique'],
    ['start', id],
    ['rm', '--force', id],
  ]);
});

test('uncertain Docker creation names the exact manual recovery target', async () => {
  const owner = createContainerOwner(async () => {
    throw new Error('CLI timed out');
  });
  await assert.rejects(
    owner.createAndStart(['--name', 'iwa02-rendered-api-controlled']),
    /inspect the exact run name iwa02-rendered-api-controlled before manual removal/u,
  );
  assert.deepEqual(owner.ownedContainerIds(), []);
});

test('concurrent smoke runs derive distinct collision-free names', () => {
  const first = smokeRunIdentifier('00000000-0000-4000-8000-000000000001');
  const second = smokeRunIdentifier('00000000-0000-4000-8000-000000000002');
  assert.notEqual(first, second);
  assert.notEqual(
    `iwa02-rendered-api-core-${first}`,
    `iwa02-rendered-api-core-${second}`,
  );
});

test('API readiness bounds a response whose body never ends', async (t) => {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"status":"ready"');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolvePromise) =>
    server.listen(0, '127.0.0.1', resolvePromise),
  );
  t.after(() => closeServerResources(server, sockets, []));
  const port = server.address().port;
  const started = Date.now();
  assert.equal(
    await readApiReadiness(
      globalThis.fetch,
      `http://127.0.0.1:${String(port)}/health/ready`,
      60,
    ),
    false,
  );
  assert.ok(Date.now() - started < 1_000);
});

test('worker readiness executes the complete rendered conjunction', () => {
  const containerId = 'b'.repeat(64);
  const command =
    'test -f /tmp/pertexo-worker-ready && test ! -f /tmp/pertexo-worker-not-ready && kill -0 1';
  assert.deepEqual(
    renderedHealthCommand(
      ['CMD-SHELL', command],
      ['CMD-SHELL', command],
      containerId,
    ),
    ['exec', containerId, '/bin/sh', '-c', command],
  );
  assert.throws(
    () =>
      renderedHealthCommand(
        ['CMD-SHELL', command.split(' && ')[0]],
        ['CMD-SHELL', command],
        containerId,
      ),
    /rendered worker health check/u,
  );
});

test('stalled smoke commands time out and are reaped', async () => {
  const started = Date.now();
  await assert.rejects(
    runSmokeCommand(
      process.execPath,
      ['--eval', 'setInterval(() => {}, 1000)'],
      { cwd: process.cwd(), label: 'stalled smoke command', timeoutMs: 50 },
    ),
    /stalled smoke command timed out after 50ms and was reaped/u,
  );
  assert.ok(Date.now() - started < 1_000);
});

test('server close destroys in-flight sockets and upstream requests', async () => {
  const destroyed = [];
  const sockets = [{ destroy: () => destroyed.push('socket') }];
  const requests = [{ destroy: () => destroyed.push('request') }];
  const server = {
    listening: true,
    closeAllConnections: () => destroyed.push('all-connections'),
    close(callback) {
      destroyed.push('server');
      callback();
    },
  };
  await closeServerResources(server, sockets, requests);
  assert.deepEqual(destroyed, [
    'request',
    'socket',
    'all-connections',
    'server',
  ]);
});

test('cleanup failure preserves the primary smoke failure', () => {
  const primary = new Error('startup failed');
  const cleanup = new Error('cleanup failed');
  assert.throws(
    () =>
      preserveSmokeFailureDuringCleanup({ error: primary, failed: true }, [
        { status: 'rejected', reason: cleanup },
      ]),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === primary &&
      error.errors[1] === cleanup,
  );
});

test('credential URLs encode reserved user and password characters', () => {
  const value = credentialUrl({
    hostname: 'host.docker.internal',
    password: 'p@ss:/?#[]',
    pathname: '/database',
    port: 5432,
    protocol: 'postgresql',
    username: 'worker:name',
  });
  const parsed = new URL(value);
  assert.equal(decodeURIComponent(parsed.username), 'worker:name');
  assert.equal(decodeURIComponent(parsed.password), 'p@ss:/?#[]');
  assert.equal(parsed.hostname, 'host.docker.internal');
  assert.equal(parsed.port, '5432');
});

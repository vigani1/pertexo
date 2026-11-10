import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const image = docker([
  'compose',
  '-f',
  'infrastructure/single-server/backup/compose.yaml',
  'config',
  '--images',
]);
const label = 'io.pertexo.backup';
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  }).trim();
}
function idle(labels = []) {
  return docker([
    'run',
    '-d',
    '--network',
    'none',
    ...labels.flatMap((value) => ['--label', value]),
    '--entrypoint',
    'sh',
    image,
    '-c',
    'while :; do sleep 1; done',
  ]);
}
async function until(read, message) {
  const end = Date.now() + 15000;
  while (!(await read())) {
    assert.ok(Date.now() < end, message);
    await delay(50);
  }
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pertexo-j2-4600-ownership-'));
  const work = join(root, 'new');
  const previous = join(root, 'old');
  await mkdir(work);
  await mkdir(previous);
  const project = `pertexo-j2-4600-${randomUUID()}`;
  const operation = 'backup';
  const labels = [
    `${label}.helper=true`,
    `${label}.project=${project}`,
    `${label}.operation=${operation}`,
    `${label}.instance=crashed`,
  ];
  const owned = new Set();
  let child;
  let closed;
  let stderr = '';
  try {
    await run({
      work,
      previous,
      project,
      operation,
      labels,
      idle: (values) => {
        const id = idle(values);
        owned.add(id);
        return id;
      },
      start: (network = 'none') => {
        child = spawn(
          'bash',
          [
            'infrastructure/single-server/backup/rclone-requests.sh',
            work,
            network,
            image,
            project,
            operation,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        closed = once(child, 'close');
        return child;
      },
      replacement: async (stale) => {
        let id;
        await until(async () => {
          try {
            id = (await readFile(join(work, 'transport.cid'), 'utf8')).trim();
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          return id && id !== stale && /^[a-f0-9]{64}$/u.test(id);
        }, 'replacement starts within 15 seconds');
        owned.add(id);
        return id;
      },
      stderr: () => stderr,
      closed: () => closed,
    });
  } finally {
    // This test owns only its explicitly created containers and unique label scope.
    const labelled = docker([
      'ps',
      '-aq',
      '--filter',
      `label=${label}.project=${project}`,
    ])
      .split('\n')
      .filter(Boolean);
    for (const id of labelled) owned.add(id);
    for (const id of owned) {
      if (docker(['ps', '-aq', '--no-trunc']).split('\n').includes(id))
        docker(['rm', '-f', id]);
    }
    if (child) {
      child.kill('SIGTERM');
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
}

for (const scenario of [
  'missing CID',
  'garbage CID',
  'different operation directory',
]) {
  test(
    `transport restart removes its stale helper with ${scenario}`,
    { timeout: 45000 },
    async () => {
      await fixture(async (f) => {
        const stale = f.idle(f.labels);
        if (scenario === 'garbage CID')
          await writeFile(join(f.work, 'transport.cid'), 'not-a-container');
        if (scenario === 'different operation directory')
          await writeFile(join(f.previous, 'transport.cid'), stale);
        f.start();
        await f.replacement(stale);
        assert.ok(
          !docker(['ps', '-q', '--no-trunc']).split('\n').includes(stale),
          'the old identity is gone before the replacement starts',
        );
      });
    },
  );
}

test(
  'transport cleanup preserves unrelated helpers even when a CID points at one',
  { timeout: 45000 },
  async () => {
    await fixture(async (f) => {
      const stale = f.idle(f.labels);
      const foreign = f.idle([
        `${label}.helper=true`,
        `${label}.project=${f.project}`,
        `${label}.operation=restore`,
      ]);
      const otherProject = f.idle([
        `${label}.helper=true`,
        `${label}.project=${f.project}-other`,
        `${label}.operation=backup`,
      ]);
      const unlabelled = f.idle([]);
      await writeFile(join(f.work, 'transport.cid'), foreign);
      f.start();
      await f.replacement(foreign);
      const running = docker(['ps', '-q', '--no-trunc']).split('\n');
      assert.ok(!running.includes(stale));
      assert.ok(
        running.includes(foreign),
        'another operation survives a foreign CID',
      );
      assert.ok(running.includes(otherProject), 'another project survives');
      assert.ok(
        running.includes(unlabelled),
        'an unregistered container using the same image survives',
      );
    });
  },
);

test(
  'a helper that cannot start reports failure and leaves no owned container',
  { timeout: 45000 },
  async () => {
    await fixture(async (f) => {
      await writeFile(join(f.work, 'rclone.env'), 'RCLONE_CONFIG=/dev/null\n');
      const child = f.start(`pertexo-j2-4600-missing-${randomUUID()}`);
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        'startup failure exits within 15 seconds',
      );
      await f.closed();
      assert.notEqual(child.exitCode, 0);
      assert.match(f.stderr(), /Unable to start upstream rclone helper/u);
      assert.notEqual(
        (await readFile(join(f.work, 'transport.status'), 'utf8')).trim(),
        '0',
      );
      assert.equal(
        docker([
          'ps',
          '-aq',
          '--filter',
          `label=${label}.project=${f.project}`,
        ]),
        '',
      );
    });
  },
);

test(
  'stopping the dispatcher removes its helper without an external container cleanup',
  { timeout: 45000 },
  async () => {
    await fixture(async (f) => {
      const child = f.start();
      const id = await f.replacement();
      await until(async () => {
        try {
          return (
            (await readFile(join(f.work, 'transport.ready'), 'utf8')).length > 0
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return false;
        }
      }, 'the helper becomes ready');
      child.kill('SIGTERM');
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        'the dispatcher exits after termination',
      );
      await f.closed();
      assert.ok(
        !docker(['ps', '-q', '--no-trunc']).split('\n').includes(id),
        'the owner removes its helper',
      );
    });
  },
);

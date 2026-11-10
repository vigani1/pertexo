import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const image = execFileSync(
  'docker',
  [
    'compose',
    '-f',
    'infrastructure/single-server/backup/compose.yaml',
    'config',
    '--images',
  ],
  { encoding: 'utf8' },
).trim();

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  }).trim();
}

test(
  'restarting the transport removes the helper left by a crashed run',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pertexo-j2-4300-'));
    let child;
    let closed;
    const containers = new Set();
    try {
      const stale = docker([
        'run',
        '-d',
        '--network',
        'none',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'while :; do sleep 1; done',
      ]);
      containers.add(stale);
      await writeFile(join(directory, 'transport.cid'), stale);
      child = spawn(
        'bash',
        [
          'infrastructure/single-server/backup/rclone-requests.sh',
          directory,
          'none',
          image,
        ],
        { stdio: 'ignore' },
      );
      closed = once(child, 'close');
      const deadline = Date.now() + 15000;
      let replacement;
      while (Date.now() < deadline) {
        try {
          replacement = (
            await readFile(join(directory, 'transport.cid'), 'utf8')
          ).trim();
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (replacement && replacement !== stale) break;
        await delay(50);
      }
      if (replacement && replacement !== stale) containers.add(replacement);
      assert.ok(
        replacement && replacement !== stale,
        'replacement helper starts within 15 seconds',
      );
      const running = docker(['ps', '-q', '--no-trunc']).split('\n');
      assert.ok(
        !running.includes(stale),
        'crashed run must not leave an upstream helper running',
      );
    } finally {
      // Remove only containers created by this test, including a late startup.
      containers.add(await savedContainer(directory));
      for (const container of containers) {
        if (container) docker(['rm', '-f', container]);
      }
      if (child) {
        child.kill('SIGTERM');
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function savedContainer(directory) {
  try {
    return (await readFile(join(directory, 'transport.cid'), 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test(
  'an unavailable image fails the real waiting transport request within 15 seconds',
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pertexo-j2-image-4300-'));
    const helper = spawn(
      'bash',
      [
        'infrastructure/single-server/backup/rclone-requests.sh',
        directory,
        'none',
        '127.0.0.1:5450/pertexo-j2-unavailable:4300',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let message = '';
    helper.stderr.on('data', (chunk) => {
      message += chunk;
    });
    const helperClosed = once(helper, 'close');
    const waiter = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { rclone } from ${JSON.stringify(pathToFileURL(resolve('infrastructure/single-server/backup/transport.mjs')).href)};
await rclone(['version']);
`,
      ],
      {
        env: { ...process.env, BACKUP_TRANSPORT_DIRECTORY: directory },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let response = '';
    waiter.stderr.on('data', (chunk) => {
      response += chunk;
    });
    const waiterClosed = once(waiter, 'close');
    try {
      const [code] = await Promise.race([
        waiterClosed,
        delay(15000).then(() =>
          assert.fail(
            'unavailable image left the request waiting past 15 seconds',
          ),
        ),
      ]);
      assert.notEqual(code, 0, 'the request must fail closed');
      assert.match(response, /Unable to start upstream rclone helper/u);
      const [helperCode] = await helperClosed;
      assert.notEqual(helperCode, 0);
      assert.match(message, /Unable to start upstream rclone helper/u);
    } finally {
      waiter.kill('SIGKILL');
      helper.kill('SIGTERM');
      await Promise.all([waiterClosed, helperClosed]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'killing an upstream helper during a real transfer rejects its waiting caller',
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'pertexo-j2-transfer-4300-'),
    );
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
    const helper = spawn(
      'bash',
      [
        'infrastructure/single-server/backup/rclone-requests.sh',
        directory,
        'none',
        image,
      ],
      { stdio: 'ignore' },
    );
    const helperClosed = once(helper, 'close');
    let waiter;
    let waiterClosed;
    try {
      await writeFile(join(directory, 'input'), Buffer.alloc(1024 * 1024, 'x'));
      await untilFile(
        async () =>
          (await readFile(join(directory, 'transport.ready'), 'utf8')).length >
          0,
      );
      waiter = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
import { rclone } from ${JSON.stringify(pathToFileURL(resolve('infrastructure/single-server/backup/transport.mjs')).href)};
await rclone(['copyto','/backup/input','/backup/output','--bwlimit','16k']);
`,
        ],
        {
          env: { ...process.env, BACKUP_TRANSPORT_DIRECTORY: directory },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let response = '';
      waiter.stderr.on('data', (chunk) => {
        response += chunk;
      });
      waiterClosed = once(waiter, 'close');
      await untilFile(async () => {
        const files = await readdir(directory);
        for (const file of files.filter((file) => file.endsWith('.partial')))
          if ((await stat(join(directory, file))).size > 0) return true;
        return false;
      });
      const cid = (
        await readFile(join(directory, 'transport.cid'), 'utf8')
      ).trim();
      execFileSync('docker', ['kill', cid], { stdio: 'pipe', timeout: 5000 });
      const [code] = await Promise.race([
        waiterClosed,
        delay(3000).then(() =>
          assert.fail('dead transport did not release the waiting caller'),
        ),
      ]);
      assert.notEqual(code, 0);
      assert.match(response, /Upstream rclone helper stopped/u);
      assert.ok(
        !(await readdir(directory)).includes('output'),
        'a partial transfer is never presented as complete',
      );
    } finally {
      waiter?.kill('SIGKILL');
      helper.kill('SIGTERM');
      if (waiterClosed) await waiterClosed;
      await helperClosed;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function untilFile(read) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if (await read()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  assert.fail(
    'real transport did not reach its expected transfer state within 15 seconds',
  );
}

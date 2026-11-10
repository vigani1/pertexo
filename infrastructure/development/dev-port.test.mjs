import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const web = resolve('apps/web');
const pnpm = execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim();

test(
  'dev serves the chosen port and shutdown preserves an unrelated server',
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pertexo-j2-dev-4300-'));
    const unrelated = createServer((_request, response) =>
      response.end('unrelated'),
    );
    let child;
    let closed;
    try {
      unrelated.listen(5450, '127.0.0.1');
      await once(unrelated, 'listening');
      await mkdir(join(root, 'infrastructure/development'), {
        recursive: true,
      });
      await mkdir(join(root, 'bin'));
      await copyFile(
        new URL('./dev.mjs', import.meta.url),
        join(root, 'infrastructure/development/dev.mjs'),
      );
      await writeFile(
        join(root, '.env.example'),
        'PUBLIC_WEB_ORIGIN=http://127.0.0.1:5440\nPORT=0\n',
      );
      // Deployment services are outside this process-lifetime test; Vite is real.
      await writeFile(join(root, 'bin/docker'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      await writeFile(
        join(root, 'bin/pnpm'),
        `#!${process.execPath}
const {spawn}=require('node:child_process');
if(process.argv[2]!=='--filter')process.exit(0);
require('node:fs').writeFileSync(${JSON.stringify(root)}+'/'+process.argv[3].split('/').at(-1),String(process.pid));
if(process.argv[3]==='@pertexo/web') {
  const child=spawn(${JSON.stringify(pnpm)},['--dir',${JSON.stringify(web)},'dev'],{stdio:'inherit'});
  child.on('exit',code=>process.exit(code??1));
} else setInterval(()=>{},1000);
`,
        { mode: 0o755 },
      );
      child = spawn(
        process.execPath,
        [join(root, 'infrastructure/development/dev.mjs')],
        {
          env: {
            ...process.env,
            PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5440',
            PORT: '0',
            PATH: `${root}/bin:${process.env.PATH}`,
          },
          stdio: 'ignore',
        },
      );
      closed = once(child, 'close');
      await until(async () => {
        const response = await fetch('http://127.0.0.1:5440', {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok && (await response.text()).includes('/@vite/client');
      }, 'Vite serves the configured origin');
      child.kill('SIGINT');
      await Promise.race([
        closed,
        delay(5000).then(() =>
          assert.fail('dev shutdown exceeded five seconds'),
        ),
      ]);
      await until(async () => {
        try {
          await fetch('http://127.0.0.1:5440', {
            signal: AbortSignal.timeout(500),
          });
          return false;
        } catch {
          return true;
        }
      }, 'owned Vite listener stops');
      assert.equal(
        await (await fetch('http://127.0.0.1:5450')).text(),
        'unrelated',
      );
    } finally {
      child?.kill('SIGINT');
      for (const name of ['api', 'code-runner', 'worker', 'web'])
        await stopOwnedGroup(join(root, name));
      if (closed) await closed;
      unrelated.closeAllConnections();
      await new Promise((done) => unrelated.close(done));
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* The listener may still be starting. */
    }
    await delay(100);
  }
  assert.fail(message);
}

async function stopOwnedGroup(file) {
  let pid;
  try {
    pid = Number(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

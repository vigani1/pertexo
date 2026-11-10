import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test(
  'SIGINT stops the development applications and their descendants',
  { timeout: 10_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pertexo-dev-'));
    const directory = join(root, 'infrastructure/development');
    const bin = join(root, 'bin');
    mkdirSync(directory, { recursive: true });
    mkdirSync(bin);
    copyFileSync(
      new URL('./dev.mjs', import.meta.url),
      join(directory, 'dev.mjs'),
    );
    writeFileSync(
      join(root, '.env.example'),
      'PUBLIC_WEB_ORIGIN=http://127.0.0.1:5460\nPORT=0\n',
    );
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/usr/bin/env node
const {spawn}=require('node:child_process');
if(process.argv[2]!=='--filter')process.exit(0);
const name=process.argv[3].split('/').at(-1);
spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",${JSON.stringify(root)}+'/'+name],{stdio:'inherit'});
setInterval(()=>{},1000);
`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [join(directory, 'dev.mjs')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: 'ignore',
    });
    const closed = once(child, 'close');
    const pids = [];
    try {
      for (const name of ['api', 'code-runner', 'worker', 'web']) {
        const file = join(root, name);
        const deadline = Date.now() + 5000;
        while (!existsSync(file) && Date.now() < deadline) await delay(20);
        assert.ok(existsSync(file), `${name} started`);
        pids.push(Number(readFileSync(file, 'utf8')));
      }
      child.kill('SIGINT');
      await Promise.race([
        closed,
        delay(3000).then(() => {
          throw new Error('development command did not stop');
        }),
      ]);
      await delay(100);
      for (const pid of pids)
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      child.kill('SIGKILL');
      for (const pid of pids) killIfRunning(pid);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function killIfRunning(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

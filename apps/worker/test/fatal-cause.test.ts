import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { workerEnvironment } from './support/worker-environment.js';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const EXIT_LIMIT_MS = 30_000;

async function runWorker(environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [entrypoint], {
    env: { PATH: process.env.PATH, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      output += chunk;
    });
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker did not exit: ${output}`));
    }, EXIT_LIMIT_MS);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, output };
}

describe('a worker that cannot start', () => {
  it('exits with a failure when a required setting is missing', async () => {
    const { DATABASE_URL: _missing, ...environment } = workerEnvironment;
    const { code } = await runWorker(environment);
    expect(code).toBe(1);
  });

  // ops-08: the fatal line carries only `errorType`, so the operator retries blind.
  it.fails('names the missing setting in its fatal line', async () => {
    const { DATABASE_URL: _missing, ...environment } = workerEnvironment;
    const { output } = await runWorker(environment);
    expect(output).toContain('DATABASE_URL');
  });

  // ops-08: the same blind line for a value that is present but wrong.
  it.fails('names the invalid setting in its fatal line', async () => {
    const { output } = await runWorker({
      ...workerEnvironment,
      OUTBOX_DISPATCH_BATCH_SIZE: '0',
    });
    expect(output).toContain('OUTBOX_DISPATCH_BATCH_SIZE');
  });

  it('never prints the value of a rejected secret setting', async () => {
    const { output } = await runWorker({
      ...workerEnvironment,
      DATABASE_URL: 'mysql://user:do-not-print-me@localhost/pertexo',
    });
    expect(output).not.toContain('do-not-print-me');
  });
});

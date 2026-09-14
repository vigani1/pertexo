import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(
  new URL('./api-main-process.fixture.mjs', import.meta.url),
);
const entrypointPath = fileURLToPath(
  new URL('../dist/main.js', import.meta.url),
);
const signalFixturePath = fileURLToPath(
  new URL('./api-signal-process.fixture.mjs', import.meta.url),
);

async function runChild(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  code: number | null;
  output: string;
  signal: NodeJS.Signals | null;
}> {
  const child = spawn(process.execPath, [path], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`API main child timed out: ${output}`));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, output, signal });
    });
  });
}

async function runSignalChild(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Awaited<ReturnType<typeof runChild>>> {
  const child = spawn(process.execPath, [signalFixturePath], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const completion = new Promise<Awaited<ReturnType<typeof runChild>>>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`API signal child timed out: ${output}`));
      }, 5_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, output, signal });
      });
    },
  );
  let signaled = false;
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    if (!signaled && output.includes('application.ready')) {
      signaled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  return completion;
}

describe('compiled API main process', () => {
  it('executes the exported bootstrap and cleans listen failure owners', async () => {
    const result = await runChild(fixturePath);

    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.output).toContain('api.bootstrap_failed');
    expect(result.output).toContain('application.closed');
    expect(result.output).toContain('telemetry.closed');
    expect(result.output).toContain('bootstrap.failed');
  });

  it('executes the actual main guard and fixed invalid-config formatter', async () => {
    const result = await runChild(entrypointPath, {
      ...process.env,
      DATABASE_API_URL: '',
    });

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.output).toContain('"event":"api.process_failed"');
    expect(result.output).toContain('"errorType":"Error"');
    expect(result.output).not.toContain('DATABASE_API_URL');
  });

  it('settles every real Nest owner before completing SIGTERM shutdown', async () => {
    const result = await runSignalChild();

    expect(result).toMatchObject({ code: null, signal: 'SIGTERM' });
    expect(result.output.match(/telemetry\.closed/g)).toHaveLength(1);
    expect(result.output.match(/database\.closed/g)).toHaveLength(1);
  });

  it('attempts every owner and exits nonzero when signal cleanup fails', async () => {
    const result = await runSignalChild({
      ...process.env,
      DB_CLOSE_FAIL: '1',
    });

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.output.match(/telemetry\.closed/g)).toHaveLength(1);
    expect(result.output.match(/database\.closed/g)).toHaveLength(1);
  });
});

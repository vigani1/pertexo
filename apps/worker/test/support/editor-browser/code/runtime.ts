import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import type { DatabaseConfig } from '@pertexo/database/platform';
import { createWorkerNodeRuntimeCapabilities } from '../../../../src/attempts/execution/runtime-capabilities.js';

/** Development/CI uses the approved separate-process path, never an evaluator stub. */
export async function createEditorCodeRuntime(database: DatabaseConfig) {
  const directory = await mkdtemp('/tmp/pertexo-code-browser-');
  const socketPath = join(directory, 'runner.sock');
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../../../code-runner/dist/main.js', import.meta.url),
      ),
    ],
    {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        CODE_RUNNER_SOCKET: socketPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let startupError: Error | undefined;
  child.on('error', (error) => {
    startupError = error;
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 4096)
      stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
  });
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => {
      resolve();
    }),
  );
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        await rm(directory, { recursive: true, force: true });
      }
    })());
  try {
    for (let index = 0; ; index++) {
      if (startupError !== undefined) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Owned Code runner failed: ' + stderr);
      if ((await lstat(socketPath).catch(() => null))?.isSocket()) break;
      if (index >= 200)
        throw new Error('Owned Code runner did not become ready');
      await delay(25);
    }
    const capabilities = await createWorkerNodeRuntimeCapabilities({
      database,
      codeRunner: {
        settings: DEFAULT_CODE_SETTINGS,
        socketPath,
        requireHardened: false,
      },
    });
    return { capabilities, close };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}

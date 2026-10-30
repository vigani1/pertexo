import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { redisPassword, repositoryRoot } from './environment.js';

const execFileAsync = promisify(execFile);
const COMPOSE_LIMIT_MS = 120_000;

export type ComposeService = 'artifact-store' | 'postgres' | 'redis';

async function compose(...arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: COMPOSE_LIMIT_MS,
  });
  return stdout.trim();
}

/** Stops the real container, the way a crash, restart or outage takes it away. */
export async function stopService(service: ComposeService): Promise<void> {
  await compose('stop', '--timeout', '10', service);
}

/** Starts the same container and returns once its health check passes. */
export async function startService(service: ComposeService): Promise<void> {
  await compose(
    'up',
    '--detach',
    '--wait',
    '--no-recreate',
    '--no-deps',
    service,
  );
}

export async function redisCommand(
  database: number,
  ...arguments_: readonly string[]
): Promise<string> {
  return compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--raw',
    '--no-auth-warning',
    '-a',
    redisPassword,
    '-n',
    String(database),
    ...arguments_,
  );
}

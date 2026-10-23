import { execFile } from 'node:child_process';

import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { repositoryRoot } from './environment.js';

const execFileAsync = promisify(execFile);

const servicesNeedingRestore = new Set<'postgres' | 'redis'>();

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return result.stdout.trim();
}

export async function stopService(
  service: 'postgres' | 'redis',
): Promise<void> {
  servicesNeedingRestore.add(service);
  await compose('stop', '--timeout', '10', service);
}

export async function startService(
  service: 'postgres' | 'redis',
): Promise<number> {
  const startedAt = performance.now();
  await compose('up', '-d', '--wait', service);
  servicesNeedingRestore.delete(service);
  return performance.now() - startedAt;
}

export async function restoreServices(): Promise<void> {
  const services = [...servicesNeedingRestore];
  if (services.length === 0) return;
  await compose('up', '-d', '--wait', ...services);
  servicesNeedingRestore.clear();
}

import { execFile } from 'node:child_process';

import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { z } from 'zod';

import { createDockerComposeServiceController } from '../../../support/infrastructure/compose-service-control.js';

import {
  repositoryRoot,
  REDIS_PROOF_DATABASE,
  SERVICE_OPERATION_TIMEOUT_MS,
  redisPassword,
} from './environment.js';
import type { ProofMeasurements } from './contract.js';
import { dispatcherPool } from './database.js';

const execFileAsync = promisify(execFile);

const serviceController = createDockerComposeServiceController({
  cwd: repositoryRoot,
  operationTimeoutMillis: SERVICE_OPERATION_TIMEOUT_MS,
});

type StoppedService = Awaited<ReturnType<typeof serviceController.stop>>;

const stoppedServices = new Map<'postgres' | 'redis', StoppedService>();

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: SERVICE_OPERATION_TIMEOUT_MS,
  });
  return result.stdout.trim();
}

export async function restoreServices(): Promise<void> {
  const errors: unknown[] = [];
  for (const [service, stopped] of [...stoppedServices])
    await serviceController
      .start(stopped)
      .then(() => stoppedServices.delete(service))
      .catch((error: unknown) => errors.push(error));
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Transport resilience service restore failed',
    );
}

export async function stopProofService(
  service: 'postgres' | 'redis',
): Promise<StoppedService> {
  if (stoppedServices.has(service))
    throw new Error(
      `Compose service ${service} is already stopped by this proof`,
    );
  const stopped = await serviceController.stop(service);
  stoppedServices.set(service, stopped);
  return stopped;
}

export async function startProofService(
  stopped: StoppedService,
): Promise<number> {
  const duration = await serviceController.start(stopped);
  stoppedServices.delete(stopped.service);
  return duration;
}

export async function flushProofRedis(): Promise<void> {
  const response = await compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--raw',
    '--no-auth-warning',
    '-a',
    redisPassword,
    '-n',
    String(REDIS_PROOF_DATABASE),
    'FLUSHDB',
  );
  if (response !== 'OK') {
    throw new Error('Redis proof database did not acknowledge FLUSHDB');
  }
}

export async function dependencyEvidence(
  measurements: ProofMeasurements,
): Promise<void> {
  const pool = dispatcherPool();
  try {
    const result = await pool.query<{
      migration_head: string;
      postgres_version: string;
    }>(`
      select
        current_setting('server_version') as postgres_version,
        (
          select name
          from pertexo_internal.schema_migrations
          order by name desc
          limit 1
        ) as migration_head
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Missing dependency evidence');
    measurements.migrationHead = row.migration_head;
    measurements.postgresVersion = row.postgres_version;
  } finally {
    await pool.end();
  }

  measurements.redisVersion = await compose(
    'exec',
    '-T',
    'redis',
    'redis-server',
    '--version',
  );
  const workerPackage = z
    .object({ devDependencies: z.object({ bullmq: z.string().min(1) }) })
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../../../package.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  measurements.bullmqVersion = workerPackage.devDependencies.bullmq;
}

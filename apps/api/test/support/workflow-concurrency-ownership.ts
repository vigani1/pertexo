import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

/** Exact task attestation, never discovery or permission to clean other services. */
export async function verifyWorkflowConcurrencyOwnership(): Promise<void> {
  for (const name of [
    'DATABASE_ADMIN_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_API_URL',
    'DATABASE_WORKER_URL',
    'DATABASE_DISPATCHER_URL',
    'DATABASE_MAINTENANCE_URL',
    'DATABASE_LIFECYCLE_COMMAND_URL',
    'DATABASE_OPERATOR_URL',
  ]) {
    const url = new URL(process.env[name] ?? '');
    if (
      url.protocol !== 'postgresql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== '55440'
    )
      throw new Error('Explicit owned concurrency PostgreSQL URL required');
  }
  const redis = new URL(process.env.REDIS_URL ?? '');
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1'].includes(redis.hostname) ||
    redis.port !== '56383'
  )
    throw new Error('Explicit owned concurrency Redis URL required');
  for (const [name, port, host] of [
    ['pertexo-concurrency-db-20261001', '5432/tcp', '55440'],
    ['pertexo-concurrency-redis-20261001', '6379/tcp', '56383'],
  ] as const) {
    const { stdout } = await promisify(execFile)('docker', ['inspect', name], {
      timeout: 4_000,
      maxBuffer: 1_048_576,
    });
    const inspected = z
      .array(
        z.object({
          Name: z.string(),
          State: z.object({ Running: z.boolean() }),
          Config: z.object({ Labels: z.record(z.string(), z.string()) }),
          NetworkSettings: z.object({
            Ports: z.record(
              z.string(),
              z
                .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
                .nullable(),
            ),
          }),
        }),
      )
      .length(1)
      .parse(JSON.parse(stdout))[0];
    const bindings = inspected?.NetworkSettings.Ports[port];
    if (
      inspected?.Name !== `/${name}` ||
      !inspected.State.Running ||
      inspected.Config.Labels['pertexo.task'] !== 'workflow-concurrency' ||
      bindings?.length !== 1 ||
      bindings[0]?.HostIp !== '127.0.0.1' ||
      bindings[0].HostPort !== host
    )
      throw new Error('Owned concurrency service attestation failed');
  }
}

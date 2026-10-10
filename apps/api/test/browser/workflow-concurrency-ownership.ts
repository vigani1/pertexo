import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const databaseUrlNames = [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_URL',
  'DATABASE_MAINTENANCE_URL',
] as const;
const inspectedSchema = z
  .array(
    z.object({
      Id: z.string().optional(),
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
  .length(1);
type Environment = Readonly<Record<string, string | undefined>>;
type DockerRead = (arguments_: readonly string[]) => Promise<string>;
const dockerRead: DockerRead = async (arguments_) => {
  const { stdout } = await promisify(execFile)('docker', arguments_, {
    timeout: 4_000,
    maxBuffer: 1_048_576,
  });
  return stdout;
};
function explicitPort(value: string | undefined): string {
  if (
    value === undefined ||
    !/^[1-9][0-9]{0,4}$/u.test(value) ||
    Number(value) > 65_535
  )
    throw new Error('Explicit valid concurrency fixture port required');
  return value;
}
function composeProject(env: Environment): string | undefined {
  const project = env.WORKFLOW_CONCURRENCY_COMPOSE_PROJECT;
  if (project === undefined && env.COMPOSE_PROJECT_NAME === undefined)
    return undefined;
  if (
    project === undefined ||
    project !== env.COMPOSE_PROJECT_NAME ||
    !/^(?:pertexo-ci-[0-9]+-[0-9]+-browser|pertexo-concurrency-browser-[a-z0-9][a-z0-9-]{6,30}[a-z0-9])$/u.test(
      project,
    )
  )
    throw new Error('Explicit owned concurrency Compose project required');
  return project;
}
function verifyUrls(env: Environment, postgresPort: string, redisPort: string) {
  for (const name of databaseUrlNames) {
    const url = new URL(env[name] ?? '');
    if (
      url.protocol !== 'postgresql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== postgresPort
    )
      throw new Error('Explicit owned concurrency PostgreSQL URL required');
  }
  const redis = new URL(env.REDIS_URL ?? '');
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1'].includes(redis.hostname) ||
    redis.port !== redisPort
  )
    throw new Error('Explicit owned concurrency Redis URL required');
}
async function verifyService(
  docker: DockerRead,
  service: 'postgres' | 'redis',
  project: string | undefined,
  hostPort: string,
) {
  const localName =
    service === 'postgres'
      ? 'pertexo-concurrency-db-20261001'
      : 'pertexo-concurrency-redis-20261001';
  let target = localName;
  if (project !== undefined) {
    const ids = (
      await docker(['compose', '--project-name', project, 'ps', '-q', service])
    )
      .trim()
      .split(/\s+/u);
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0] ?? ''))
      throw new Error('One exact owned concurrency Compose container required');
    target = ids[0] ?? '';
  }
  const inspected = inspectedSchema.parse(
    JSON.parse(await docker(['inspect', target])),
  )[0];
  const bindings =
    inspected?.NetworkSettings.Ports[
      service === 'postgres' ? '5432/tcp' : '6379/tcp'
    ];
  const owned =
    project === undefined
      ? inspected?.Name === `/${localName}` &&
        inspected.Config.Labels['pertexo.task'] === 'workflow-concurrency'
      : inspected?.Id === target &&
        inspected.Config.Labels['com.docker.compose.project'] === project &&
        inspected.Config.Labels['com.docker.compose.service'] === service;
  if (
    !owned ||
    inspected?.State.Running !== true ||
    bindings?.length !== 1 ||
    bindings[0]?.HostIp !== '127.0.0.1' ||
    bindings[0].HostPort !== hostPort
  )
    throw new Error('Owned concurrency service attestation failed');
}
/** Read-only attestation: explicit Compose project or the original exact local task. */
export async function verifyWorkflowConcurrencyOwnership(
  env: Environment = process.env,
  docker: DockerRead = dockerRead,
): Promise<void> {
  const project = composeProject(env);
  const postgresPort =
    project === undefined ? '55440' : explicitPort(env.POSTGRES_PORT);
  const redisPort =
    project === undefined ? '56383' : explicitPort(env.REDIS_PORT);
  verifyUrls(env, postgresPort, redisPort);
  await verifyService(docker, 'postgres', project, postgresPort);
  await verifyService(docker, 'redis', project, redisPort);
}

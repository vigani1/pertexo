import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { verifyEditorBrowserOwnership } from './editor-browser-ownership.js';

/** Never infer ownership from discovered resources or fall back to normal services. */
export async function verifyConnectionHealthOwnership(
  env: Readonly<Record<string, string | undefined>> = process.env,
  read: (args: readonly string[]) => Promise<string> = async (args) =>
    (
      await promisify(execFile)('docker', args, {
        timeout: 4000,
        maxBuffer: 1048576,
      })
    ).stdout,
) {
  const project = env.CONNECTION_HEALTH_COMPOSE_PROJECT;
  if (
    project === undefined ||
    project !== env.COMPOSE_PROJECT_NAME ||
    !/^(?:pertexo-ci-[0-9]+-[0-9]+-(?:browser|integration)|pertexo-local-quality-[a-z0-9-]+|pertexo-connection-health-[a-z0-9][a-z0-9-]{6,30}[a-z0-9])$/u.test(
      project,
    )
  )
    throw new Error(
      'Explicit owned connection-health Compose project required',
    );
  const port = (value: string | undefined) => {
    if (
      value === undefined ||
      !/^[1-9][0-9]{0,4}$/u.test(value) ||
      Number(value) > 65535
    )
      throw new Error('Explicit valid connection-health fixture port required');
    return Number(value);
  };
  const postgresPort = port(env.POSTGRES_PORT),
    redisPort = port(env.REDIS_PORT);
  for (const name of [
    'ADMIN',
    'MIGRATION',
    'API',
    'WORKER',
    'DISPATCHER',
    'MAINTENANCE',
    'LIFECYCLE_COMMAND',
    'OPERATOR',
  ]) {
    const url = new URL(env[`DATABASE_${name}_URL`] ?? '');
    if (
      url.protocol !== 'postgresql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== String(postgresPort)
    )
      throw new Error('Explicit owned connection-health database URL required');
  }
  const id = async (service: string) => {
    const value = (
      await read(['compose', '--project-name', project, 'ps', '-q', service])
    ).trim();
    if (!/^[a-f0-9]{64}$/u.test(value))
      throw new Error('One exact owned connection-health service required');
    return value;
  };
  const postgresId = await id('postgres'),
    redisId = await id('redis');
  await verifyEditorBrowserOwnership(
    {
      ...env,
      EDITOR_BROWSER_OWNED_FIXTURE: 'true',
      EDITOR_BROWSER_OWNERSHIP_MANIFEST: JSON.stringify({
        project,
        postgres: { id: postgresId, port: postgresPort },
        redis: { id: redisId, port: redisPort },
      }),
    },
    async (target) => {
      const raw = await read(['inspect', target]);
      const inspected = z
        .array(
          z.object({
            Config: z.object({ Labels: z.record(z.string(), z.string()) }),
          }),
        )
        .length(1)
        .parse(JSON.parse(raw));
      if (
        inspected[0]?.Config.Labels['com.docker.compose.service'] !==
        (target === postgresId ? 'postgres' : 'redis')
      )
        throw new Error('Owned connection-health service identity mismatch');
      return raw;
    },
  );
}

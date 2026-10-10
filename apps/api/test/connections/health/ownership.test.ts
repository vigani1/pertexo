import { describe, expect, it, vi } from 'vitest';
import { verifyConnectionHealthOwnership } from './ownership.js';

function fixture() {
  const project = 'pertexo-connection-health-20261001';
  const env: Record<string, string | undefined> = {
    CONNECTION_HEALTH_COMPOSE_PROJECT: project,
    COMPOSE_PROJECT_NAME: project,
    POSTGRES_PORT: '55442',
    REDIS_PORT: '56385',
    REDIS_URL: 'redis://127.0.0.1:56385/13',
  };
  for (const name of [
    'DATABASE_ADMIN_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_URL',
    'DATABASE_MAINTENANCE_URL',
  ])
    env[name] = 'postgresql://runtime@127.0.0.1:55442/postgres';
  const read = vi.fn((args: readonly string[]) => {
    if (args[0] === 'compose')
      return Promise.resolve(
        args.at(-1) === 'postgres' ? 'a'.repeat(64) : 'b'.repeat(64),
      );
    const postgres = args[1] === 'a'.repeat(64);
    return Promise.resolve(
      JSON.stringify([
        {
          Id: args[1],
          State: { Running: true },
          Config: {
            Labels: {
              'com.docker.compose.project': project,
              'com.docker.compose.service': postgres ? 'postgres' : 'redis',
            },
          },
          NetworkSettings: {
            Ports: {
              [postgres ? '5432/tcp' : '6379/tcp']: [
                { HostIp: '127.0.0.1', HostPort: postgres ? '55442' : '56385' },
              ],
            },
          },
        },
      ]),
    );
  });
  return { env, read };
}

describe('connection health ownership preflight', () => {
  it('attests the explicitly selected services before acquisition', async () => {
    const { env, read } = fixture();
    await verifyConnectionHealthOwnership(env, read);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it.each(['selector', 'project', 'port', 'role'] as const)(
    'rejects missing or mismatched %s without Docker discovery',
    async (reason) => {
      const { env, read } = fixture();
      if (reason === 'selector') delete env.CONNECTION_HEALTH_COMPOSE_PROJECT;
      if (reason === 'project') env.COMPOSE_PROJECT_NAME = 'pertexo';
      if (reason === 'port') env.POSTGRES_PORT = '0';
      if (reason === 'role') delete env.DATABASE_MAINTENANCE_URL;
      await expect(
        verifyConnectionHealthOwnership(env, read),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );
  it('rejects multiple service IDs rather than selecting one', async () => {
    const { env, read } = fixture();
    read.mockResolvedValueOnce(`${'a'.repeat(64)}\n${'c'.repeat(64)}`);
    await expect(verifyConnectionHealthOwnership(env, read)).rejects.toThrow(
      'One exact',
    );
  });
  it('rejects a foreign service even under the correct project label', async () => {
    const { env, read } = fixture();
    const inspect = JSON.parse(await read(['inspect', 'a'.repeat(64)])) as [
      { Config: { Labels: Record<string, string> } },
    ];
    inspect[0].Config.Labels['com.docker.compose.service'] = 'unrelated';
    read
      .mockResolvedValueOnce('a'.repeat(64))
      .mockResolvedValueOnce('b'.repeat(64))
      .mockResolvedValueOnce(JSON.stringify(inspect));
    await expect(verifyConnectionHealthOwnership(env, read)).rejects.toThrow(
      'service identity',
    );
  });
});

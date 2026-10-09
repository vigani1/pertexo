import { describe, expect, it, vi } from 'vitest';
import { verifyWorkflowConcurrencyOwnership } from './workflow-concurrency-ownership.js';

const urlNames = [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_URL',
  'DATABASE_MAINTENANCE_URL',
] as const;
const postgresId = 'a'.repeat(64),
  redisId = 'b'.repeat(64);
function fixture(selectedProject: string | null = 'pertexo-ci-1234-2-browser') {
  const project = selectedProject ?? undefined;
  const postgresPort = project === undefined ? '55440' : '55441';
  const redisPort = project === undefined ? '56383' : '56384';
  const env: Record<string, string | undefined> = {
    POSTGRES_PORT: postgresPort,
    REDIS_PORT: redisPort,
    REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
  };
  if (project !== undefined) {
    env.WORKFLOW_CONCURRENCY_COMPOSE_PROJECT = project;
    env.COMPOSE_PROJECT_NAME = project;
  }
  for (const name of urlNames)
    env[name] = `postgresql://runtime@localhost:${postgresPort}/fixture`;
  const containers = {
    postgres: {
      Id: postgresId,
      Name:
        project === undefined
          ? '/pertexo-concurrency-db-20261001'
          : `/${project}-postgres-1`,
      State: { Running: true },
      Config: {
        Labels: {
          'pertexo.task': 'workflow-concurrency',
          'com.docker.compose.project': project ?? '',
          'com.docker.compose.service': 'postgres',
        },
      },
      NetworkSettings: {
        Ports: {
          '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: postgresPort }],
        },
      },
    },
    redis: {
      Id: redisId,
      Name:
        project === undefined
          ? '/pertexo-concurrency-redis-20261001'
          : `/${project}-redis-1`,
      State: { Running: true },
      Config: {
        Labels: {
          'pertexo.task': 'workflow-concurrency',
          'com.docker.compose.project': project ?? '',
          'com.docker.compose.service': 'redis',
        },
      },
      NetworkSettings: {
        Ports: { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: redisPort }] },
      },
    },
  };
  const outputs: Record<string, string> = {
    postgres: `${postgresId}\n`,
    redis: `${redisId}\n`,
  };
  const docker = vi.fn((args: readonly string[]) => {
    if (args[0] === 'compose')
      return Promise.resolve(outputs[args[5] ?? ''] ?? '');
    if (args[0] !== 'inspect')
      return Promise.reject(new Error('Unexpected Docker mutation'));
    const postgres =
      args[1] === postgresId || args[1] === 'pertexo-concurrency-db-20261001';
    return Promise.resolve(
      JSON.stringify([postgres ? containers.postgres : containers.redis]),
    );
  });
  return { env, containers, outputs, docker };
}

describe('workflow concurrency ownership attestation', () => {
  it.each([
    'pertexo-ci-1234-2-browser',
    'pertexo-concurrency-browser-oct01-abcdef1234',
  ])(
    'accepts exact Compose-attested %s without service mutation',
    async (project) => {
      const { env, docker } = fixture(project);
      await verifyWorkflowConcurrencyOwnership(env, docker);
      expect(docker.mock.calls).toEqual([
        [['compose', '--project-name', project, 'ps', '-q', 'postgres']],
        [['inspect', postgresId]],
        [['compose', '--project-name', project, 'ps', '-q', 'redis']],
        [['inspect', redisId]],
      ]);
    },
  );
  it('preserves the original exact local task names, ports and label', async () => {
    const { env, docker } = fixture(null);
    await verifyWorkflowConcurrencyOwnership(env, docker);
    expect(docker.mock.calls).toEqual([
      [['inspect', 'pertexo-concurrency-db-20261001']],
      [['inspect', 'pertexo-concurrency-redis-20261001']],
    ]);
  });
  it.each([
    'pertexo',
    'pertexo-ci-1-2',
    'pertexo-ci-1-2-browser-extra',
    'pertexo-ci-x-2-browser',
    'pertexo-concurrency-browser-short',
    'pertexo-concurrency-browser-UPPER123',
    `pertexo-concurrency-browser-${'a'.repeat(33)}`,
    'pertexo-concurrency-browser--abcdefgh',
  ])('rejects unapproved project %s before Docker', async (project) => {
    const { env, docker } = fixture(project);
    await expect(
      verifyWorkflowConcurrencyOwnership(env, docker),
    ).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
  });
  it.each(['selector', 'compose-name', 'mismatch'] as const)(
    'rejects missing/mismatching %s project before Docker',
    async (reason) => {
      const { env, docker } = fixture();
      if (reason === 'selector')
        delete env.WORKFLOW_CONCURRENCY_COMPOSE_PROJECT;
      if (reason === 'compose-name') delete env.COMPOSE_PROJECT_NAME;
      if (reason === 'mismatch')
        env.COMPOSE_PROJECT_NAME = 'pertexo-ci-1234-3-browser';
      await expect(
        verifyWorkflowConcurrencyOwnership(env, docker),
      ).rejects.toThrow();
      expect(docker).not.toHaveBeenCalled();
    },
  );
  it.each(urlNames)('requires explicit %s before Docker', async (name) => {
    const { env, docker } = fixture();
    env[name] = undefined;
    await expect(
      verifyWorkflowConcurrencyOwnership(env, docker),
    ).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
  });
  it.each([
    'postgres://runtime@127.0.0.1:55441/fixture',
    'postgresql://runtime@remote.test:55441/fixture',
    'postgresql://runtime@127.0.0.1:5432/fixture',
  ])('rejects unowned role URL %s before Docker', async (url) => {
    const { env, docker } = fixture();
    env.DATABASE_MAINTENANCE_URL = url;
    await expect(
      verifyWorkflowConcurrencyOwnership(env, docker),
    ).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
  });
  it.each(['POSTGRES_PORT', 'REDIS_PORT'] as const)(
    'requires explicit valid %s before Docker',
    async (name) => {
      for (const value of [
        undefined,
        '',
        '0',
        '65536',
        '054441',
        '-1',
        '1.5',
        ' 55441',
      ]) {
        const { env, docker } = fixture();
        env[name] = value;
        await expect(
          verifyWorkflowConcurrencyOwnership(env, docker),
        ).rejects.toThrow();
        expect(docker).not.toHaveBeenCalled();
      }
    },
  );
  it.each([
    undefined,
    'redis://remote.test:56384/0',
    'redis://127.0.0.1:6379/0',
    'rediss://127.0.0.1:56384/0',
  ])('rejects unowned Redis URL %s', async (url) => {
    const { env, docker } = fixture();
    env.REDIS_URL = url;
    await expect(
      verifyWorkflowConcurrencyOwnership(env, docker),
    ).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'abc',
    `${postgresId}\n${redisId}\n`,
    `${postgresId} ${postgresId}`,
  ])('requires exactly one full Compose container ID %s', async (output) => {
    const { env, outputs, docker } = fixture();
    outputs.postgres = output;
    await expect(
      verifyWorkflowConcurrencyOwnership(env, docker),
    ).rejects.toThrow();
    expect(docker).toHaveBeenCalledTimes(1);
  });
  it.each([
    'id',
    'project',
    'service',
    'stopped',
    'binding',
    'port',
    'multiple-bindings',
  ] as const)('rejects Docker %s mismatch', async (reason) => {
    const { env, containers, docker } = fixture();
    const container = containers.postgres;
    if (reason === 'id') container.Id = redisId;
    if (reason === 'project')
      container.Config.Labels['com.docker.compose.project'] =
        'pertexo-ci-99-99-browser';
    if (reason === 'service')
      container.Config.Labels['com.docker.compose.service'] = 'redis';
    if (reason === 'stopped') container.State.Running = false;
    if (reason === 'binding')
      container.NetworkSettings.Ports['5432/tcp'] = [
        { HostIp: '0.0.0.0', HostPort: '55441' },
      ];
    if (reason === 'port')
      container.NetworkSettings.Ports['5432/tcp'] = [
        { HostIp: '127.0.0.1', HostPort: '5432' },
      ];
    if (reason === 'multiple-bindings')
      container.NetworkSettings.Ports['5432/tcp'].push({
        HostIp: '::1',
        HostPort: '55441',
      });
    await expect(
      verifyWorkflowConcurrencyOwnership(env, docker),
    ).rejects.toThrow('attestation failed');
  });
  it.each(['name', 'task-label', 'url-port'] as const)(
    'rejects changed default local %s',
    async (reason) => {
      const { env, containers, docker } = fixture(null);
      if (reason === 'name') containers.postgres.Name = '/unowned';
      if (reason === 'task-label')
        containers.postgres.Config.Labels['pertexo.task'] = 'other';
      if (reason === 'url-port')
        env.DATABASE_URL = 'postgresql://runtime@127.0.0.1:55441/fixture';
      await expect(
        verifyWorkflowConcurrencyOwnership(env, docker),
      ).rejects.toThrow();
    },
  );
});

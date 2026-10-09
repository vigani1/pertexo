import { describe, expect, it, vi } from 'vitest';
import { verifyEditorBrowserOwnership } from './editor-browser-ownership.js';

const manifest = {
  project: 'pertexo-owned-unit-fixture',
  postgres: { id: 'a'.repeat(64), port: 55436 },
  redis: { id: 'b'.repeat(64), port: 56380 },
};
function fixture() {
  const env: Record<string, string | undefined> = {
    EDITOR_BROWSER_OWNED_FIXTURE: 'true',
    EDITOR_BROWSER_OWNERSHIP_MANIFEST: JSON.stringify(manifest),
    REDIS_URL: 'redis://127.0.0.1:56380/0',
  };
  for (const name of [
    'DATABASE_ADMIN_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_URL',
    'DATABASE_MAINTENANCE_URL',
  ])
    env[name] = 'postgresql://runtime@127.0.0.1:55436/postgres';
  const inspect = vi.fn((id: string) =>
    Promise.resolve(
      JSON.stringify([
        {
          Id: id,
          State: { Running: true },
          Config: {
            Labels: { 'com.docker.compose.project': manifest.project },
          },
          NetworkSettings: {
            Ports:
              id === manifest.postgres.id
                ? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55436' }] }
                : { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '56380' }] },
          },
        },
      ]),
    ),
  );
  return { env, inspect };
}
describe('editor browser fixture preflight', () => {
  it('accepts only exact attested container/port mappings', async () => {
    const { env, inspect } = fixture();
    await verifyEditorBrowserOwnership(env, inspect);
    expect(inspect.mock.calls).toEqual([
      [manifest.postgres.id],
      [manifest.redis.id],
    ]);
  });
  it.each([
    'attestation',
    'manifest',
    'default-project',
    'old-fixture',
    'url-mismatch',
  ] as const)(
    'rejects %s before Docker or resource acquisition',
    async (reason) => {
      const { env, inspect } = fixture();
      if (reason === 'attestation') delete env.EDITOR_BROWSER_OWNED_FIXTURE;
      if (reason === 'manifest') delete env.EDITOR_BROWSER_OWNERSHIP_MANIFEST;
      if (reason === 'default-project')
        env.EDITOR_BROWSER_OWNERSHIP_MANIFEST = JSON.stringify({
          ...manifest,
          project: 'pertexo',
        });
      if (reason === 'old-fixture')
        env.EDITOR_BROWSER_OWNERSHIP_MANIFEST = JSON.stringify({
          ...manifest,
          postgres: { ...manifest.postgres, port: 55435 },
        });
      if (reason === 'url-mismatch')
        env.DATABASE_URL = 'postgresql://runtime@127.0.0.1:55435/postgres';
      await expect(
        verifyEditorBrowserOwnership(env, inspect),
      ).rejects.toThrow();
      expect(inspect).not.toHaveBeenCalled();
    },
  );
  it.each(['id', 'project', 'stopped', 'port', 'binding'] as const)(
    'rejects Docker %s mismatch without reaching acquisition',
    async (reason) => {
      const { env, inspect } = fixture();
      const acquired = vi.fn();
      const original = JSON.parse(await inspect(manifest.postgres.id)) as [
        {
          Id: string;
          State: { Running: boolean };
          Config: { Labels: Record<string, string> };
          NetworkSettings: {
            Ports: Record<string, { HostIp: string; HostPort: string }[]>;
          };
        },
      ];
      if (reason === 'id') original[0].Id = 'c'.repeat(64);
      if (reason === 'project')
        original[0].Config.Labels['com.docker.compose.project'] =
          'pertexo-other';
      if (reason === 'stopped') original[0].State.Running = false;
      if (reason === 'port')
        original[0].NetworkSettings.Ports['5432/tcp'] = [
          { HostIp: '127.0.0.1', HostPort: '5432' },
        ];
      if (reason === 'binding')
        original[0].NetworkSettings.Ports['5432/tcp'] = [
          { HostIp: '0.0.0.0', HostPort: '55436' },
        ];
      inspect.mockResolvedValue(JSON.stringify(original));
      await expect(
        verifyEditorBrowserOwnership(env, inspect).then(acquired),
      ).rejects.toThrow(/preflight failed/u);
      expect(acquired).not.toHaveBeenCalled();
    },
  );
});

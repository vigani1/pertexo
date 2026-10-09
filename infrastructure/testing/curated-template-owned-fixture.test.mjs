import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  curatedDatabaseUrl,
  curatedRedisUrl,
  recheckCuratedFixtureOwnership,
  verifyCuratedFixtureOwnership,
} from './curated-template-owned-fixture.mjs';

function fixture() {
  const manifest = {
    project: 'pertexo-curated-owned-unit',
    postgres: { id: 'a'.repeat(64), port: 55461 },
    redis: { id: 'b'.repeat(64), port: 56391 },
  };
  const environment = {
    EDITOR_BROWSER_OWNED_FIXTURE: 'true',
    EDITOR_BROWSER_OWNERSHIP_MANIFEST: JSON.stringify(manifest),
    REDIS_URL: 'redis://:synthetic-unit@127.0.0.1:56391/0',
  };
  for (const [name, role] of [
    ['DATABASE_ADMIN_URL', 'postgres'],
    ['DATABASE_MIGRATION_URL', 'pertexo_migration'],
    ['DATABASE_URL', 'pertexo_app'],
    ['DATABASE_MAINTENANCE_URL', 'pertexo_maintenance'],
  ])
    environment[name] =
      `postgresql://${role}:synthetic-unit@127.0.0.1:55461/${name === 'DATABASE_ADMIN_URL' ? 'postgres' : 'pertexo'}`;
  let inspected = 0;
  const inspect = async (id) => {
    inspected++;
    const postgres = id === manifest.postgres.id;
    return JSON.stringify([
      {
        Id: id,
        State: { Running: true },
        Config: { Labels: { 'com.docker.compose.project': manifest.project } },
        NetworkSettings: {
          Ports: {
            [postgres ? '5432/tcp' : '6379/tcp']: [
              {
                HostIp: '127.0.0.1',
                HostPort: String(postgres ? 55461 : 56391),
              },
            ],
          },
        },
      },
    ]);
  };
  return { environment, inspect, manifest, inspected: () => inspected };
}

test('curated callers reuse exact canonical ownership at variable task-owned ports', async () => {
  const input = fixture();
  const owned = await verifyCuratedFixtureOwnership(
    input.environment,
    input.inspect,
  );
  assert.equal(owned.postgresPort, 55461);
  assert.equal(owned.redisPort, 56391);
  assert.equal(owned.project, input.manifest.project);
  assert.equal(input.inspected(), 2);
  assert.ok(Object.isFrozen(owned));
});

for (const reason of [
  'flag',
  'manifest',
  'shared-port',
  'role',
  'admin-database',
  'redis-password',
  'query',
])
  test(`curated ownership rejects ${reason} without acquiring any resource`, async () => {
    const input = fixture();
    if (reason === 'flag')
      delete input.environment.EDITOR_BROWSER_OWNED_FIXTURE;
    if (reason === 'manifest')
      delete input.environment.EDITOR_BROWSER_OWNERSHIP_MANIFEST;
    if (reason === 'shared-port')
      input.environment.DATABASE_URL = input.environment.DATABASE_URL.replace(
        '55461',
        '55435',
      );
    if (reason === 'role')
      input.environment.DATABASE_URL = input.environment.DATABASE_URL.replace(
        'pertexo_app',
        'postgres',
      );
    if (reason === 'admin-database')
      input.environment.DATABASE_ADMIN_URL =
        input.environment.DATABASE_ADMIN_URL.replace(
          '/postgres',
          '/user_database',
        );
    if (reason === 'redis-password')
      input.environment.REDIS_URL = 'redis://127.0.0.1:56391/0';
    if (reason === 'query')
      input.environment.DATABASE_URL += '?application_name=unreviewed';
    await assert.rejects(
      verifyCuratedFixtureOwnership(input.environment, input.inspect),
    );
  });

for (const reason of ['id', 'project', 'stopped', 'binding', 'port'])
  test(`curated canonical Docker attestation rejects ${reason}`, async () => {
    const input = fixture();
    const inspect = async (id) => {
      const rows = JSON.parse(await input.inspect(id));
      if (reason === 'id') rows[0].Id = 'c'.repeat(64);
      if (reason === 'project')
        rows[0].Config.Labels['com.docker.compose.project'] = 'pertexo-unowned';
      if (reason === 'stopped') rows[0].State.Running = false;
      const bindings = Object.values(rows[0].NetworkSettings.Ports)[0];
      if (reason === 'binding') bindings[0].HostIp = '0.0.0.0';
      if (reason === 'port') bindings[0].HostPort = '5432';
      return JSON.stringify(rows);
    };
    await assert.rejects(
      verifyCuratedFixtureOwnership(input.environment, inspect),
      /preflight failed/u,
    );
  });

test('curated namespace derivation cannot target shared databases or Redis DB0', () => {
  const input = fixture();
  const name = `pertexo_test_f06_guard_${'a'.repeat(24)}`;
  assert.equal(
    new URL(curatedDatabaseUrl(input.environment.DATABASE_URL, name)).pathname,
    `/${name}`,
  );
  assert.equal(
    new URL(curatedRedisUrl(input.environment.REDIS_URL, 12)).pathname,
    '/12',
  );
  for (const rejected of [
    'pertexo',
    'postgres',
    'pertexo_test_f06_guard_wrong',
    `${name};drop`,
  ])
    assert.throws(() =>
      curatedDatabaseUrl(input.environment.DATABASE_URL, rejected),
    );
  for (const rejected of [0, 9, 13, -1, 1.5])
    assert.throws(() => curatedRedisUrl(input.environment.REDIS_URL, rejected));
});

test('cleanup refuses a changed manifest even when its replacement is separately attested', async () => {
  const input = fixture();
  const owned = await verifyCuratedFixtureOwnership(
    input.environment,
    input.inspect,
  );
  input.manifest.project = 'pertexo-replacement-unit';
  input.environment.EDITOR_BROWSER_OWNERSHIP_MANIFEST = JSON.stringify(
    input.manifest,
  );
  await assert.rejects(
    recheckCuratedFixtureOwnership(owned, input.environment, input.inspect),
    /ownership changed/u,
  );
});

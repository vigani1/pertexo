import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const execute = promisify(execFile);
const roleUrls = Object.freeze({
  DATABASE_ADMIN_URL: 'postgres',
  DATABASE_MIGRATION_URL: 'pertexo_migration',
  DATABASE_API_URL: 'pertexo_api',
  DATABASE_WORKER_URL: 'pertexo_worker',
  DATABASE_DISPATCHER_URL: 'pertexo_dispatcher',
});

/** Reuses the canonical editor-fixture attestation; never discovers/adopts services. */
export async function verifyCuratedFixtureOwnership(
  environment = process.env,
  inspect = async (id) =>
    (
      await execute('docker', ['inspect', id], {
        timeout: 4000,
        maxBuffer: 1048576,
      })
    ).stdout,
) {
  const { verifyEditorBrowserOwnership } = await tsImport(
    '../../apps/api/test/support/editor-browser-ownership.ts',
    import.meta.url,
  );
  await verifyEditorBrowserOwnership(environment, inspect);
  for (const [name, role] of Object.entries(roleUrls)) {
    const url = new URL(environment[name]);
    if (
      url.username !== role ||
      url.password.length === 0 ||
      url.search !== '' ||
      url.hash !== '' ||
      (name === 'DATABASE_ADMIN_URL' && url.pathname !== '/postgres')
    )
      throw new Error(`Curated fixture requires the explicit ${name} role URL`);
  }
  const redis = new URL(environment.REDIS_URL);
  if (redis.password.length === 0 || redis.search !== '' || redis.hash !== '')
    throw new Error('Curated fixture requires an explicit owned Redis URL');
  const manifest = JSON.parse(environment.EDITOR_BROWSER_OWNERSHIP_MANIFEST);
  return Object.freeze({
    project: manifest.project,
    postgresId: manifest.postgres.id,
    redisId: manifest.redis.id,
    postgresPort: manifest.postgres.port,
    redisPort: manifest.redis.port,
    adminUrl: environment.DATABASE_ADMIN_URL,
    migrationUrl: environment.DATABASE_MIGRATION_URL,
    apiUrl: environment.DATABASE_API_URL,
    workerUrl: environment.DATABASE_WORKER_URL,
    dispatcherUrl: environment.DATABASE_DISPATCHER_URL,
    redisUrl: environment.REDIS_URL,
  });
}

export function curatedDatabaseUrl(base, name) {
  if (!/^pertexo_test_f06_(?:guard|origin|cutover)_[a-f0-9]{24}$/u.test(name))
    throw new Error('Curated fixture database is outside its owned namespace');
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function recheckCuratedFixtureOwnership(
  expected,
  environment = process.env,
  inspect,
) {
  const current = await verifyCuratedFixtureOwnership(environment, inspect);
  for (const key of Object.keys(expected))
    if (current[key] !== expected[key])
      throw new Error('Curated fixture ownership changed after acquisition');
}

export function curatedRedisUrl(base, database) {
  if (![10, 11, 12].includes(database))
    throw new Error(
      'Curated fixture Redis database is outside its owned namespace',
    );
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

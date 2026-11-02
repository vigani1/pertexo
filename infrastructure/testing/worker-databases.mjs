import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * A database of its own for each Vitest worker, copied from the migrated one, so an
 * integration suite's files can run at once. Rules that read across workspaces, such
 * as claiming due work, count everything in the database, and that's why these
 * suites used to run one file at a time. Copying is cheap: four take about 300 ms.
 */
const WORKERS = 4;

// `pg` belongs to the package whose suite is running.
const require = createRequire(`${process.cwd()}/package.json`);
const { Client } = require('pg');

/** The suite's Vitest settings. A suite with its own needs overrides what it must. */
export const parallelIntegrationSuite = Object.freeze({
  environment: 'node',
  include: ['test/**/*.integration.test.ts'],
  pool: 'forks',
  fileParallelism: true,
  maxWorkers: WORKERS,
  // Four files at once on a four-core runner beside PostgreSQL: the 5 s default is
  // for a machine doing one thing.
  testTimeout: 30_000,
  hookTimeout: 60_000,
  globalSetup: [fileURLToPath(import.meta.url)],
  setupFiles: [
    fileURLToPath(new URL('worker-database-env.mjs', import.meta.url)),
  ],
});

const databaseName = (url) => new URL(url).pathname.slice(1);

/** Vitest's global setup: runs once, after migrations and before any worker. */
export default async function copyDatabases() {
  const template = databaseName(process.env.DATABASE_URL);
  const admin = new Client({
    connectionString: process.env.DATABASE_ADMIN_URL,
  });
  await admin.connect();
  try {
    const owner = await admin.query(
      'select pg_get_userbyid(datdba) as owner from pg_database where datname = $1',
      [template],
    );
    for (let worker = 1; worker <= WORKERS; worker += 1) {
      const copy = `${template}_w${worker}`;
      await admin.query(`drop database if exists "${copy}" with (force)`);
      await admin.query(
        `create database "${copy}" template "${template}" owner "${owner.rows[0].owner}"`,
      );
    }
  } finally {
    await admin.end();
  }
}

export { WORKERS };

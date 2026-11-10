import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const databaseRuntimeProbe = fileURLToPath(import.meta.url);
if (process.argv[1] === databaseRuntimeProbe) await qualifyDatabaseRuntime();

async function qualifyDatabaseRuntime() {
  const [platformModule, primitivesModule, ormModule] = process.argv.slice(2);
  assert.equal(
    process.argv.slice(2).length,
    3,
    'the caller names the production modules to resolve',
  );
  const root = 'file:///workspace/';
  const api = `${root}apps/api/dist/main.js`;
  const worker = `${root}apps/worker/dist/main.js`;
  const core = `${root}packages/core/dist/data-tables/data-table.errors.js`;
  const apiDatabase = import.meta.resolve(platformModule, api);
  const workerDatabase = import.meta.resolve(platformModule, worker);
  const modules = await Promise.all(
    [apiDatabase, workerDatabase, core].map(
      async (parent) => import(import.meta.resolve(ormModule, parent)),
    ),
  );
  for (const module of modules)
    assert.equal(
      module.DrizzleQueryError,
      modules[0].DrizzleQueryError,
      'API, worker and core share the runtime Drizzle identity',
    );
  const { Pool } = await import(import.meta.resolve('pg', apiDatabase));
  const { drizzle } = await import(
    import.meta.resolve(`${ormModule}/node-postgres`, workerDatabase)
  );
  const { sql } = modules[0];
  const { translateWorkerFailure } = await import(core);
  const { postgresFailure } = await import(
    import.meta.resolve(primitivesModule, core)
  );
  const pool = new Pool({
    connectionString: 'postgres://postgres:fixture@database/postgres',
  });
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query(
      'create table j2_errors (id integer primary key, value integer not null)',
    );
    await a.query('insert into j2_errors values (1, 0)');
    await expectOutcome(
      drizzle(a).execute(sql`insert into j2_errors values (1, 1)`),
      '23505',
      'key_conflict',
      /unique key/u,
    );
    await a.query('begin isolation level serializable');
    await a.query('select * from j2_errors');
    await b.query('update j2_errors set value=1 where id=1');
    await expectOutcome(
      drizzle(a).execute(sql`update j2_errors set value=2 where id=1`),
      '40001',
      'unavailable',
      /retried safely/u,
    );
    await a.query('rollback');
    await b.query('begin');
    await b.query('update j2_errors set value=3 where id=1');
    await a.query("set lock_timeout='100ms'");
    await expectOutcome(
      drizzle(a).execute(sql`update j2_errors set value=4 where id=1`),
      '55P03',
      'unavailable',
      /retried safely/u,
    );
    await b.query('rollback');
    assert.equal(
      (await a.query('select value from j2_errors where id=1')).rows[0].value,
      1,
      'failed writes never commit',
    );
    console.log(
      'One runtime Drizzle identity; real 23505/40001/55P03 produce key_conflict/unavailable/unavailable',
    );
  } finally {
    await a.query('rollback');
    await b.query('rollback');
    a.release();
    b.release();
    await pool.end();
  }

  async function expectOutcome(promise, postgresCode, code, message) {
    await assert.rejects(promise, (error) => {
      assert.equal(postgresFailure(error).code, postgresCode);
      assert.throws(
        () => translateWorkerFailure(error),
        (translated) => {
          assert.equal(translated.code, code);
          assert.match(translated.message, message);
          return true;
        },
      );
      return true;
    });
  }
}

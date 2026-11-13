import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  findSessionSettings,
  transactionLocalScope,
  unexemptedSessionSettings,
  validateTransactionLocalSettings,
} from './transaction-local-settings.mjs';

const statements = (source) =>
  findSessionSettings('sample.ts', source).map(({ statement }) => statement);

test('passes the repository, whose settings are all transaction-local', async () => {
  const { checked } = await validateTransactionLocalSettings();
  assert.ok(checked > 1_000);
});

// Every sample here once passed the check (batch J9 review, check-bypass.mjs)
// or is a form the check must refuse; each must now be found on its own.
const REJECTED = {
  'set_config with false': `client.query("select set_config('app.workspace_id', $1, false)", [id]);`,
  'set_config with FALSE in a template': `client.query(\`select set_config('app.actor_id',\${actor},FALSE)\`);`,
  'set_config false in a drizzle template': `db.execute(sql\`select set_config('lock_timeout',\${\`\${ms}ms\`},false)\`);`,
  'set_config with a parameter flag': `client.query("select set_config($1, $2, $3)", [a, b, local]);`,
  'set_config with a template variable flag':
    'client.query(`select set_config($1, $2, ${isLocal})`);',
  'set_config with a column flag': `client.query("select set_config('a', $1, is_local)");`,
  'set_config built by concatenation': `client.query("select set_config('app.workspace_id', $1, " + local + ")", [id]);`,
  'set_config named through a variable':
    "const fn = 'set_config'; client.query(`select ${fn}('a', $1, false)`);",
  'set_config with two arguments': `client.query("select set_config('a', $1)");`,
  'set_config in a DO block': `client.query("do $$ begin perform set_config('app.workspace_id', 'x', false); end $$");`,
  'SET with an interpolated name': 'client.query(`set ${name} = ${value}`);',
  'SET TO with an interpolated name':
    'client.query(`SET ${name} TO ${value}`);',
  'SET built by concatenation': `client.query('set ' + 'app.workspace_id = ' + id);`,
  'SET built from an array': `client.query(['set', 'app.workspace_id', '=', id].join(' '));`,
  'SET after a line comment': `client.query('-- scope\\nset app.workspace_id = 1');`,
  'SET after a block comment': `client.query('/* scope */ SET app.workspace_id = 1');`,
  'SET after another statement': `client.query('begin; set app.workspace_id to 1; commit');`,
  'SET in mixed case': `client.query("Set app.workspace_id To 'x'");`,
  'SET with a function value': `client.query("set app.workspace_id = current_setting('x')");`,
  'SET with a cast value': `client.query("set statement_timeout = '5s'::text");`,
  'SET ROLE': `client.query('set role pertexo_owner');`,
  'SET ROLE with an interpolated role': 'client.query(`set role "${role}"`);',
  'SET SESSION': `client.query("SET SESSION app.workspace_id = 'x'");`,
  'SET SESSION CHARACTERISTICS': `client.query('set session characteristics as transaction read only');`,
  'SET SESSION AUTHORIZATION': `client.query('set session authorization pertexo_app');`,
  'SET TIME ZONE': `client.query("set time zone 'UTC'");`,
  'sql.raw SET': `sql.raw("set statement_timeout = 0")`,
  RESET: `client.query("reset app.workspace_id");`,
  'RESET ALL': `client.query('RESET ALL');`,
  'RESET ROLE': `client.query('reset role');`,
  'DO with EXECUTE SET': `client.query("do $$ begin execute 'set app.workspace_id = ''x'''; end $$");`,
  // A quoted argument the parser misreads makes a later "true" look like the flag.
  'set_config whose dollar-quoted value hides the flag': `client.query("select set_config('app.workspace_id', $q$, true) ,$q$, false)");`,
  'set_config whose escape-string value hides the flag': `client.query("select set_config('app.workspace_id', E'\\\\', true) ,', false)");`,
  'a pool startup setting': `new Pool({ connectionString, options: '-c app.workspace_id=x' });`,
  'a client startup setting without a space': `new Client({ options: '-capp.actor_id=x' });`,
  'a pool startup setting in long form': `new Pool({ host, options: '--search_path=app' });`,
  'a pool startup setting from a variable': `const config = { connectionString: url, options };`,
  'a pool startup setting from a call': `const config = { connectionString: url, options: startupOptions() };`,
  'a startup setting in a connection string': `const url = 'postgresql://u@h/db?options=-c%20app.workspace_id%3Dx';`,
  'a startup setting added to a connection URL': `url.searchParams.set('options', '-c role=pertexo_owner');`,
  'a connection URL startup setting from a variable': `url.searchParams.set('options', startup);`,
  'a PGOPTIONS startup setting': `process.env.PGOPTIONS = '-c app.organization_id=x';`,
  'a PGOPTIONS startup setting in long form': `execSync('PGOPTIONS=--search_path=app psql');`,
  'DO with a language': `client.query("DO LANGUAGE plpgsql $body$ begin null; end $body$");`,
};

for (const [name, source] of Object.entries(REJECTED))
  test(`rejects ${name}`, () => {
    assert.notDeepEqual(statements(source), [], source);
  });

test('accepts transaction-local settings and SQL that changes no setting', () => {
  assert.deepEqual(
    statements(`
      await client.query("select set_config('app.workspace_id', $1, true)", [id]);
      await client.query("select set_config('app.mode', 'E', true), set_config('app.cost', 'a$b$c', true)");
      await client.query(\`select set_config('app.\${name}', $\${index}, true)\`, values);
      await client.query(\`select set_config('\${name}',$\${n},TRUE) "\${key}"\`, values);
      await db.execute(sql\`select set_config('app.workspace_id',coalesce(\${id}::text,''),true)\`);
      await client.query('set local role pertexo_owner');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query('-- bounded\\nset local lock_timeout = 1000');
      await client.query('set transaction isolation level serializable');
      await client.query('set constraints all deferred');
      await client.query("update app.users set status='x' where id=$1");
      await client.query('insert into t values (1) on conflict do update set v=1');
      // set_config('app.workspace_id', $1, false) in a comment is no SQL.
    `),
    [],
  );
});

test('accepts the allowed startup setting, command-line flags and other options', () => {
  assert.deepEqual(
    statements(`
      new Pool({ connectionString, options: '-c statement_timeout=5000' });
      url.searchParams.set('options', '-c statement_timeout=5000');
      spawn('sh', ['-c', 'pg_dump --format=custom']);
      execFile('docker', ['compose', 'run', '--pull=never']);
      const options = { encryption: true };
      createServer({ options: { port: 1 } });
    `),
    [],
  );
});

test('treats lone words and foreign key actions as values', () => {
  assert.deepEqual(
    statements(`
      type Outcome = 'reset' | 'invalid';
      const result = { kind: 'set' };
      map.get('Set');
      references(() => runs.id, { onDelete: 'set null' });
      foreignKey({ columns: [a], foreignColumns: [b] }).onDelete('set null');
    `),
    [],
  );
  assert.notDeepEqual(statements(`const action = 'set null';`), []);
});

test('lets a reasoned marker exempt one statement, and refuses a stale marker', () => {
  const exempted = `
    // session-setting-exempt: a message shown to people, not SQL
    const hint = 'set NODE_ENV to production';
    const sql = 'set role pertexo_owner';
  `;
  assert.deepEqual(
    unexemptedSessionSettings('sample.ts', exempted).map(
      ({ statement }) => statement,
    ),
    ['set role pertexo_owner'],
  );
  assert.deepEqual(
    unexemptedSessionSettings(
      'sample.ts',
      `
        // session-setting-exempt: no longer needed
        const sql = 'select 1';
      `,
    ).map(({ statement }) => statement),
    ['exemption marker exempts nothing; remove it'],
  );
  assert.notDeepEqual(
    unexemptedSessionSettings(
      'sample.ts',
      `
        // session-setting-exempt:
        const sql = 'set role pertexo_owner';
      `,
    ),
    [],
    'a marker without a reason exempts nothing',
  );
});

test('catches a session-level setting introduced into the transaction code', async () => {
  const file = path.resolve(
    import.meta.dirname,
    '../../packages/database/src/tenant-access/transactions/scope.ts',
  );
  const source = await readFile(file, 'utf8');
  assert.deepEqual(statements(source), []);
  const mutated = source.replace(
    "set_config('app.organization_id',$1,true)",
    "set_config('app.organization_id',$1,false)",
  );
  assert.notEqual(mutated, source);
  assert.deepEqual(statements(mutated), [
    "set_config('app.organization_id',$1,false)",
  ]);
});

test('scopes by named test directories and by reach to pg, not by file names', () => {
  const inScope = transactionLocalScope();
  for (const file of [
    'packages/core/src/fixture-import.repository.ts',
    'packages/core/src/testing-policy.ts',
    'packages/database/src/testing/postgres/disposable-database.ts',
    'apps/worker/src/runs/coordinator.runtime.ts',
    'infrastructure/images/database-runtime.fixture.mjs',
    'infrastructure/single-server/backup/qualify.mjs',
  ])
    assert.equal(inScope(file), true, file);
  for (const file of [
    'packages/core/test/runs/run-store/run-store.fixture.ts',
    'apps/api/test/workspaces/real-api/queries.ts',
    'infrastructure/single-server/test/restore.test.mjs',
    'packages/core/src/runs/start-run.test.ts',
    'packages/database/migrations/0000_baseline.sql',
    'apps/web/src/features/auth/pages/password-recovery.tsx',
    'packages/contracts/src/errors/api-problem.ts',
  ])
    assert.equal(inScope(file), false, file);
});

test('exempts each marked statement of the migration runner, and nothing else in it', async () => {
  const file = path.resolve(
    import.meta.dirname,
    '../../packages/database/src/migrations.ts',
  );
  const source = await readFile(file, 'utf8');
  assert.equal(findSessionSettings('migrations.ts', source).length, 4);
  assert.deepEqual(unexemptedSessionSettings('migrations.ts', source), []);
  const added = source.replace(
    "await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);",
    "await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);\n    await client.query('set search_path = app');",
  );
  assert.notEqual(added, source);
  assert.deepEqual(
    unexemptedSessionSettings('migrations.ts', added).map(
      ({ statement }) => statement,
    ),
    ['set search_path = app'],
  );
});

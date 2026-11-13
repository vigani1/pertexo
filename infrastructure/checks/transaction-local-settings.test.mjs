import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  findSessionSettings,
  validateTransactionLocalSettings,
} from './transaction-local-settings.mjs';

const statements = (source) =>
  findSessionSettings('sample.ts', source).map(({ statement }) => statement);

test('passes the repository, whose settings are all transaction-local', async () => {
  const { checked } = await validateTransactionLocalSettings();
  assert.ok(checked > 1_000);
});

test('rejects a session-level set_config, however it is written', () => {
  assert.deepEqual(
    statements(`
      await client.query("select set_config('app.workspace_id', $1, false)", [id]);
      await client.query(\`select set_config('app.actor_id',\${actor},FALSE)\`);
      await db.execute(sql\`select set_config('lock_timeout',\${\`\${ms}ms\`},false)\`);
      await client.query("select set_config('app.discovery_scope', $1, $2)", [scope, local]);
    `),
    [
      "set_config('app.workspace_id', $1, false)",
      "set_config('app.actor_id',$x,FALSE)",
      "set_config('lock_timeout',$x,false)",
      "set_config('app.discovery_scope', $1, $2)",
    ],
  );
});

test('rejects SET without LOCAL, alone or after other statements', () => {
  assert.deepEqual(
    statements(`
      await client.query('set role pertexo_owner');
      await client.query("SET statement_timeout = '5s'");
      await client.query('begin; set session app.workspace_id to "x"; commit');
      await client.query(\`set role "\${role}"\`);
      await client.query('set session_replication_role=replica');
    `),
    [
      'set role pertexo_owner',
      "SET statement_timeout = '5s'",
      'set session app.workspace_id to "x"',
      'set role "$x"',
      'set session_replication_role=replica',
    ],
  );
});

test('accepts transaction-local settings, updates and prose', () => {
  assert.deepEqual(
    statements(`
      await client.query("select set_config('app.workspace_id', $1, true)", [id]);
      await db.execute(sql\`select set_config('app.workspace_id',coalesce(\${id}::text,''),true)\`);
      await client.query('set local role pertexo_owner');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query('set transaction isolation level serializable');
      await client.query('set constraints all deferred');
      await client.query("update app.users set status='x' where id=$1");
      // set_config('app.workspace_id', $1, false) in a comment is no SQL.
      throw new Error('set NODE_ENV to development, test or production');
      const label = 'Set up a ready-made workflow';
      const onDelete = 'set null';
    `),
    [],
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

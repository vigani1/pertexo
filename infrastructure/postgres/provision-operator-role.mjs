/* global process */

import { createRequire } from 'node:module';
import { URL } from 'node:url';

const { Client } = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
)('pg');

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const identifier = (name) => {
  const value = required(name);
  if (!/^[a-z_][a-z0-9_]*$/u.test(value))
    throw new Error(`${name} must be a PostgreSQL identifier`);
  return value;
};
const format = async (client, template, values) => {
  const result = await client.query(
    `select format($1::text,${values
      .map((_, index) => `$${String(index + 2)}::text`)
      .join(',')}) statement`,
    [template, ...values],
  );
  const statement = result.rows[0]?.statement;
  if (typeof statement !== 'string')
    throw new Error('PostgreSQL format failed');
  return statement;
};

const databaseName = identifier('POSTGRES_DB');
const operatorRole = identifier('POSTGRES_OPERATOR_USER');
const operatorPassword = required('POSTGRES_OPERATOR_PASSWORD');
const client = new Client({ connectionString: required('DATABASE_ADMIN_URL') });

await client.connect();
try {
  await client.query('begin');
  const exists = await client.query(
    'select exists(select 1 from pg_roles where rolname=$1) present',
    [operatorRole],
  );
  if (exists.rows[0]?.present !== true) {
    await client.query(
      await format(
        client,
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        [operatorRole],
      ),
    );
  }
  await client.query(
    await format(
      client,
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
      [operatorRole, operatorPassword],
    ),
  );
  const memberships = await client.query(
    `select parent.rolname
     from pg_auth_members membership
     join pg_roles parent on parent.oid=membership.roleid
     join pg_roles member on member.oid=membership.member
     where member.rolname=$1`,
    [operatorRole],
  );
  for (const { rolname } of memberships.rows) {
    await client.query(
      await format(client, 'REVOKE %I FROM %I', [rolname, operatorRole]),
    );
  }
  await client.query(
    await format(client, 'GRANT CONNECT ON DATABASE %I TO %I', [
      databaseName,
      operatorRole,
    ]),
  );
  await client.query('commit');
  process.stdout.write('Operator database role is provisioned.\n');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

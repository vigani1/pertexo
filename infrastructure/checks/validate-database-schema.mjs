import { readFile, readdir } from 'node:fs/promises';
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const migrationsDirectory = path.join(
  repositoryRoot,
  'packages/database/migrations',
);
const schemaPath = path.join(repositoryRoot, 'packages/database/src/schema.ts');
const schemaDirectory = path.join(
  repositoryRoot,
  'packages/database/src/schema',
);

export async function validateDatabaseSchemaOwnership() {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const migrationSql = (
    await Promise.all(
      migrationNames.map((name) =>
        readFile(path.join(migrationsDirectory, name), 'utf8'),
      ),
    )
  ).join('\n');
  const schemaNames = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.ts'))
    .sort();
  const schemaSource = (
    await Promise.all([
      readFile(schemaPath, 'utf8'),
      ...schemaNames.map((name) =>
        readFile(path.join(schemaDirectory, name), 'utf8'),
      ),
    ])
  ).join('\n');

  return validateDatabaseSchemaSources({ migrationSql, schemaSource });
}

export function validateDatabaseSchemaSources({ migrationSql, schemaSource }) {
  if (typeof migrationSql !== 'string' || typeof schemaSource !== 'string')
    throw new TypeError('Database schema sources must be strings');

  const migrationTables = liveTables(migrationSql);
  const typedTables = matches(
    schemaSource,
    /appSchema\.table\(\s*['"]([^'"]+)/gu,
  );

  if (
    /DEFAULT\s+(?:gen_random_uuid|uuid_generate_v\d)\s*\(/iu.test(migrationSql)
  )
    throw new Error(
      'Persisted UUID defaults must be generated explicitly by their owning application or SQL operation',
    );

  const untyped = [...migrationTables].filter((name) => !typedTables.has(name));
  const absent = [...typedTables].filter((name) => !migrationTables.has(name));
  if (untyped.length > 0)
    throw new Error(
      `Migration tables without a typed schema: ${untyped.join(', ')}`,
    );
  if (absent.length > 0)
    throw new Error(
      `Typed tables absent from migrations: ${absent.join(', ')}`,
    );

  return Object.freeze({ tableCount: migrationTables.size });
}

/** Tables the migrations leave in place, applying creates and drops in order. */
function liveTables(migrationSql) {
  const tables = new Set();
  for (const [, command, name] of migrationSql.matchAll(
    /(CREATE|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?app\.([a-z0-9_]+)/giu,
  )) {
    if (command.toUpperCase() === 'CREATE') tables.add(name);
    else tables.delete(name);
  }
  return tables;
}

function matches(source, pattern) {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  validateDatabaseSchemaOwnership()
    .then(({ tableCount }) => {
      process.stdout.write(
        `Database schema ownership verified: ${tableCount} migration tables, all typed.\n`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

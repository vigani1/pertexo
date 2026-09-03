import { readFile, readdir } from 'node:fs/promises';
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const migrationsDirectory = path.join(
  repositoryRoot,
  'packages/database/migrations',
);
const schemaPath = path.join(repositoryRoot, 'packages/database/src/schema.ts');
const schemaDirectory = path.join(
  repositoryRoot,
  'packages/database/src/schema',
);
const registryPath = path.join(
  repositoryRoot,
  'packages/database/raw-sql-table-registry.json',
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
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));

  const migrationTables = matches(
    migrationSql,
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?app\.([a-z0-9_]+)/giu,
  );
  const typedTables = matches(
    schemaSource,
    /appSchema\.table\(\s*['"]([^'"]+)/gu,
  );
  const registeredTables = new Set();

  if (
    /DEFAULT\s+(?:gen_random_uuid|uuid_generate_v\d)\s*\(/iu.test(migrationSql)
  )
    throw new Error(
      'Persisted UUID defaults must be generated explicitly by their owning application or SQL operation',
    );

  if (!Array.isArray(registry))
    throw new Error('Raw SQL registry must be an array');
  for (const entry of registry) {
    if (
      typeof entry?.name !== 'string' ||
      entry.owner !== 'owner_role' ||
      !Array.isArray(entry.accessRoles) ||
      entry.accessRoles.length === 0 ||
      !['forced', 'not_applicable'].includes(entry.rls) ||
      typeof entry.reason !== 'string' ||
      entry.reason.length < 40
    ) {
      throw new Error(
        `Invalid raw SQL table registry entry: ${JSON.stringify(entry)}`,
      );
    }
    if (registeredTables.has(entry.name))
      throw new Error(`Duplicate raw SQL table registry entry: ${entry.name}`);
    registeredTables.add(entry.name);
    if (typedTables.has(entry.name))
      throw new Error(
        `Typed table must not be in raw SQL registry: ${entry.name}`,
      );
    if (!migrationTables.has(entry.name))
      throw new Error(`Registered table is not migration-owned: ${entry.name}`);
    if (entry.rls === 'forced') {
      for (const clause of ['ENABLE', 'FORCE']) {
        const pattern = new RegExp(
          `ALTER\\s+TABLE\\s+app\\.${entry.name}\\s+${clause}\\s+ROW\\s+LEVEL\\s+SECURITY`,
          'iu',
        );
        if (!pattern.test(migrationSql))
          throw new Error(
            `${entry.name} is registered as forced RLS without ${clause}`,
          );
      }
    }
  }

  const unowned = [...migrationTables].filter(
    (name) => !typedTables.has(name) && !registeredTables.has(name),
  );
  const absent = [...typedTables].filter((name) => !migrationTables.has(name));
  if (unowned.length > 0)
    throw new Error(
      `Migration tables without typed schema or registry ownership: ${unowned.join(', ')}`,
    );
  if (absent.length > 0)
    throw new Error(
      `Typed tables absent from migrations: ${absent.join(', ')}`,
    );

  return Object.freeze({
    migrationTableCount: migrationTables.size,
    typedTableCount: typedTables.size,
    rawSqlTableCount: registeredTables.size,
  });
}

function matches(source, pattern) {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  validateDatabaseSchemaOwnership()
    .then(({ migrationTableCount, typedTableCount, rawSqlTableCount }) => {
      process.stdout.write(
        `Database schema ownership verified: ${migrationTableCount} migration tables (${typedTableCount} typed, ${rawSqlTableCount} raw SQL).\n`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

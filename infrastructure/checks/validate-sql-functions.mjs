import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { SQL_FUNCTION_ALLOWLIST } from './sql-function-allowlist.mjs';
import { liveSqlFunctions } from './sql-function-definitions.mjs';

const categories = new Set([
  'transactions',
  'workspace isolation',
  'queue claiming',
  'capacity counters',
  'constraints',
  'checkpoint concurrency',
  'security integrity',
  'derived storage',
]);

/** Source fragments may contain only a subset; the repository check also rejects stale entries. */
export function validateSqlFunctionSources(migrationSql) {
  if (typeof migrationSql !== 'string')
    throw new TypeError('Migration SQL must be a string');
  const functions = liveSqlFunctions(migrationSql);
  for (const identity of functions) {
    const entry = SQL_FUNCTION_ALLOWLIST[identity];
    if (
      entry === undefined ||
      !categories.has(entry.category) ||
      !entry.reason.trim()
    )
      throw new Error(
        `SQL function ${identity} needs an ADR 069 category and recorded reason`,
      );
  }
  return Object.freeze([...functions].sort());
}

export async function validateSqlFunctionInventory() {
  const directory = path.resolve(
    import.meta.dirname,
    '../../packages/database/migrations',
  );
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const sql = (
    await Promise.all(
      names.map((name) => readFile(path.join(directory, name), 'utf8')),
    )
  ).join('\n');
  const functions = validateSqlFunctionSources(sql);
  const missing = Object.keys(SQL_FUNCTION_ALLOWLIST).filter(
    (identity) => !functions.includes(identity),
  );
  if (missing.length > 0)
    throw new Error(
      `SQL function allowlist has retired identities: ${missing.join(', ')}`,
    );
  const adr = await readFile(
    path.resolve(
      import.meta.dirname,
      '../../docs/adr/069-architecture-reset.md',
    ),
    'utf8',
  );
  for (const { category } of Object.values(SQL_FUNCTION_ALLOWLIST)) {
    if (!adr.includes(`| ${category} |`))
      throw new Error(
        `ADR 069 does not document SQL storage category: ${category}`,
      );
  }
  return Object.freeze({ functionCount: functions.length });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  validateSqlFunctionInventory()
    .then(({ functionCount }) => {
      process.stdout.write(
        `SQL function architecture verified: ${functionCount} categorized storage functions.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

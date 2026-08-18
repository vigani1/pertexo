import { migrateDatabase } from './migrations.js';
import { parseMigrationConfig } from './config.js';

async function main(): Promise<void> {
  const applied = await migrateDatabase(parseMigrationConfig());
  process.stdout.write(
    applied.length === 0
      ? 'Database already at migration head.\n'
      : `Applied migrations: ${applied.join(', ')}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error('Database migration failed', error);
  process.exitCode = 1;
});

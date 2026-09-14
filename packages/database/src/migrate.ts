import { fileURLToPath } from 'node:url';

import { parseMigrationConfig, type MigrationConfig } from './config.js';
import { migrateDatabase } from './migrations.js';

export interface MigrationCliDependencies {
  readonly loadConfig?: () => MigrationConfig;
  readonly migrate?: typeof migrateDatabase;
  readonly writeError?: (value: string) => void;
  readonly writeOutput?: (value: string) => void;
}

function classifyError(error: unknown): 'Error' | 'NonError' {
  try {
    return error instanceof Error ? 'Error' : 'NonError';
  } catch {
    return 'NonError';
  }
}

function safeWrite(writer: (value: string) => void, value: string): void {
  try {
    writer(value);
  } catch {
    // A bounded process exit remains available when output itself fails.
  }
}

export async function runMigrationCli(
  dependencies: MigrationCliDependencies = {},
): Promise<0 | 1> {
  const writeOutput =
    dependencies.writeOutput ??
    ((value: string) => {
      process.stdout.write(value);
    });
  const writeError =
    dependencies.writeError ??
    ((value: string) => {
      process.stderr.write(value);
    });
  try {
    const config = (dependencies.loadConfig ?? parseMigrationConfig)();
    const applied = await (dependencies.migrate ?? migrateDatabase)(config);
    safeWrite(
      writeOutput,
      applied.length === 0
        ? 'Database already at migration head.\n'
        : `Applied migrations: ${applied.join(', ')}\n`,
    );
    return 0;
  } catch (error: unknown) {
    safeWrite(
      writeError,
      `${JSON.stringify({
        event: 'database.migration_failed',
        errorType: classifyError(error),
        level: 'fatal',
      })}\n`,
    );
    return 1;
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

if (isMainModule()) {
  void runMigrationCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

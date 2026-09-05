import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const migrationNameSchema = z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/u);

const onlineMigrationSchema = z
  .object({
    maximumDatabaseBytes: z.number().int().positive(),
    mode: z.literal('online'),
    restartSafe: z.literal(true),
    rollbackCompatibleThrough: migrationNameSchema,
  })
  .strict();

const resumableMigrationSchema = z
  .object({
    batchLimit: z.number().int().min(1).max(10_000),
    maximumDatabaseBytes: z.number().int().positive(),
    mode: z.literal('resumable'),
    restartSafe: z.literal(true),
    rollbackCompatibleThrough: migrationNameSchema,
  })
  .strict();

const executionPlanSchema = z
  .object({
    migrations: z.record(
      migrationNameSchema,
      z.discriminatedUnion('mode', [
        onlineMigrationSchema,
        resumableMigrationSchema,
      ]),
    ),
    schemaVersion: z.literal(1),
    transactionalThrough: migrationNameSchema,
  })
  .strict();

export type NonTransactionalMigration = z.infer<
  typeof onlineMigrationSchema | typeof resumableMigrationSchema
>;

export type MigrationExecution =
  Readonly<{ mode: 'transactional' }> | NonTransactionalMigration;

export interface MigrationExecutionPlan {
  executionFor(name: string): MigrationExecution;
}

export const MIGRATION_EXECUTION_PLAN_FILE = 'migration-execution-plan.json';

export async function loadMigrationExecutionPlan(
  migrationsDirectory: string,
  migrationNames: readonly string[],
  options: Readonly<{ required: boolean }>,
): Promise<MigrationExecutionPlan> {
  let raw: string;
  try {
    raw = await readFile(
      path.join(migrationsDirectory, MIGRATION_EXECUTION_PLAN_FILE),
      'utf8',
    );
  } catch (error: unknown) {
    if (
      !options.required &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return Object.freeze({
        executionFor: () => Object.freeze({ mode: 'transactional' as const }),
      });
    throw error;
  }

  const parsed = executionPlanSchema.parse(JSON.parse(raw));
  const knownNames = new Set(migrationNames);
  for (const name of Object.keys(parsed.migrations))
    if (!knownNames.has(name))
      throw new Error(
        `Migration execution plan references unknown file: ${name}`,
      );
  for (const name of migrationNames)
    if (
      name > parsed.transactionalThrough &&
      parsed.migrations[name] === undefined
    )
      throw new Error(`Migration execution mode is undeclared: ${name}`);
  for (const [name, execution] of Object.entries(parsed.migrations)) {
    if (name <= parsed.transactionalThrough)
      throw new Error(
        `Published transactional migration cannot change mode: ${name}`,
      );
    if (execution.rollbackCompatibleThrough >= name)
      throw new Error(
        `Migration rollback window must precede the migration: ${name}`,
      );
  }

  return Object.freeze({
    executionFor: (name: string): MigrationExecution =>
      name <= parsed.transactionalThrough
        ? Object.freeze({ mode: 'transactional' as const })
        : (parsed.migrations[name] ??
          (() => {
            throw new Error(`Migration execution mode is undeclared: ${name}`);
          })()),
  });
}

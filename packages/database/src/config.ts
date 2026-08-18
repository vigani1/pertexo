import { z } from 'zod';

const databaseConfigSchema = z.object({
  connectionString: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'must be a postgresql:// URL',
    }),
  connectionTimeoutMillis: z.number().int().positive().default(5_000),
  idleTimeoutMillis: z.number().int().positive().default(30_000),
  max: z.number().int().positive().max(100).default(10),
});

export type DatabaseConfig = Readonly<z.output<typeof databaseConfigSchema>>;

export function parseDatabaseConfig(
  input: z.input<typeof databaseConfigSchema>,
): DatabaseConfig {
  return Object.freeze(databaseConfigSchema.parse(input));
}

const migrationEnvironmentSchema = z.object({
  DATABASE_MIGRATION_URL: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_MIGRATION_URL must be a postgresql:// URL',
    }),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
});

export type MigrationConfig = Readonly<{
  connectionString: string;
  ownerRole: string;
}>;

export function parseMigrationConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MigrationConfig {
  const parsed = migrationEnvironmentSchema.parse(environment);
  return Object.freeze({
    connectionString: parsed.DATABASE_MIGRATION_URL,
    ownerRole: parsed.POSTGRES_OWNER_USER,
  });
}

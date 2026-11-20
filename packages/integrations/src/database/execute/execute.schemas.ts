import { POSTGRES_LIMITS } from '@pertexo/contracts';
import { labelledChoice } from '@pertexo/node-sdk';
import {
  postgresIdentifierSchema as identifier,
  POSTGRES_IDENTIFIER_CHARACTERS,
} from '@pertexo/workflow-model';
import { z } from 'zod';

const SQL_MAX_CHARACTERS = 32_768;
const MAX_CONFLICT_COLUMNS = 32;
const MAX_CONFLICT_COLUMN_TEXT =
  MAX_CONFLICT_COLUMNS * (POSTGRES_IDENTIFIER_CHARACTERS + '\r\n'.length);
const MAX_BOUND_PARAMETERS = 1_000;
const MAX_WRITE_ROWS = 100;
const POSTGRES_OPERATIONS = {
  query: 'Run query',
  insert: 'Insert rows',
  update: 'Update rows',
  upsert: 'Upsert rows',
} as const;
const operations = labelledChoice(POSTGRES_OPERATIONS);
const operation = <Value extends keyof typeof POSTGRES_OPERATIONS>(
  value: Value,
) =>
  operations
    .extract([value])
    .meta({ const: value, title: POSTGRES_OPERATIONS[value] });

const common = {
  timeoutMillis: z
    .number()
    .int()
    .positive()
    .max(POSTGRES_LIMITS.maxTimeoutMillis)
    .optional()
    .meta({
      title: 'Timeout',
      default: POSTGRES_LIMITS.defaultTimeoutMillis,
    }),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(POSTGRES_LIMITS.maxRows)
    .optional()
    .meta({
      title: 'Row limit',
      default: POSTGRES_LIMITS.defaultRows,
    }),
};
const relation = {
  ...common,
  schema: identifier.meta({ title: 'Schema', default: 'public' }),
  table: identifier.meta({ title: 'Table' }),
};

const conflictColumnText = z.string().min(1).max(MAX_CONFLICT_COLUMN_TEXT);
const conflictColumnList = z
  .array(identifier)
  .min(1)
  .max(MAX_CONFLICT_COLUMNS)
  .refine((columns) => new Set(columns).size === columns.length);

export function conflictColumns(keys: string): string[] {
  return keys.split(/\r?\n/u);
}

const upsertKeys = conflictColumnText
  .refine(
    (value) => conflictColumnList.safeParse(conflictColumns(value)).success,
    `Enter up to ${String(MAX_CONFLICT_COLUMNS)} distinct, valid column names, one per line.`,
  )
  .meta({
    title: 'Conflict columns',
    contentMediaType: 'text/plain',
    description:
      'Separate column names with newlines. Use the exact names from the table.',
  });

export const databaseConfigSchema = z
  .discriminatedUnion('operation', [
    z.strictObject({
      ...common,
      operation: operation('query'),
      sql: z.string().trim().min(1).max(SQL_MAX_CHARACTERS).meta({
        title: 'SQL',
        contentMediaType: 'application/sql',
        description: 'Use $1, $2 and so on for values mapped to Parameters.',
        default: 'select 1 as value',
      }),
    }),
    z.strictObject({ ...relation, operation: operation('insert') }),
    z.strictObject({
      ...relation,
      operation: operation('update'),
      key: identifier.meta({ title: 'Key column' }),
    }),
    z.strictObject({
      ...relation,
      operation: operation('upsert'),
      keys: upsertKeys,
    }),
  ])
  .meta({
    title: 'Database operation',
    default: { operation: 'query', sql: 'select 1 as value' },
  });

export const databaseInputSchema = z.strictObject({
  parameters: z
    .array(z.json())
    .max(MAX_BOUND_PARAMETERS)
    .optional()
    .meta({ title: 'Parameters' }),
  rows: z
    .array(z.record(identifier, z.json()))
    .min(1)
    .max(MAX_WRITE_ROWS)
    .optional()
    .meta({
      title: 'Rows',
      description:
        'Map an array of row objects using the exact column names. For updates, include the key column in each row.',
    }),
});

export const databaseOutputSchema = z.strictObject({
  items: z.array(z.record(z.string(), z.json())).max(POSTGRES_LIMITS.maxRows),
  rowCount: z.number().int().nonnegative(),
});

export type DatabaseConfig = z.output<typeof databaseConfigSchema>;
export type DatabaseInput = z.output<typeof databaseInputSchema>;

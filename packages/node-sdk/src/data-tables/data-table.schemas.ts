import { z } from 'zod';
import { inspectBoundedJson } from '../values/bounds.js';

export const DATA_TABLE_OPERATIONS = [
  'find',
  'insert',
  'update',
  'upsert',
  'delete',
] as const;
export function isDataTableDefinition(
  definition: Readonly<{ key: string; version: number }>,
): boolean {
  return (
    definition.version === 1 &&
    DATA_TABLE_OPERATIONS.some(
      (operation) => definition.key === `core.table_${operation}`,
    )
  );
}

export const DATA_TABLE_LIMITS = Object.freeze({
  tables: 20,
  columns: 20,
  rows: 10_000,
  bytes: 50 * 1024 * 1024,
  maxTables: 100,
  maxColumns: 50,
  maxRows: 100_000,
  maxBytes: 1024 * 1024 * 1024,
  rowBytes: 65_536,
  batchRows: 1_000,
  resultBytes: 1_048_576,
  keyBytes: 1024,
});

const KEY_COLUMN_TYPES: readonly string[] = ['text', 'number', 'date'];

/** A unique key must always have a value that compares exactly. */
export function isDataTableKeyColumn(
  column: Readonly<{ type: string; required: boolean }>,
): boolean {
  return column.required && KEY_COLUMN_TYPES.includes(column.type);
}
/** What a row or filter value may hold, checked before any recursive parse. */
export const DATA_TABLE_JSON_LIMITS = Object.freeze({
  bytes: DATA_TABLE_LIMITS.rowBytes,
  depth: 32,
  members: 8_000,
});
// A table's name is shown to people and finds the table for its steps, so
// like n8n it may hold words with spaces; column names stay identifiers.
export const DATA_TABLE_NAME_PATTERN =
  '^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9_-])?$';
export const dataTableNameSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(DATA_TABLE_NAME_PATTERN, 'u'),
    'Use letters, numbers, spaces, hyphens and underscores, starting with a letter or number (64 at most).',
  );
export const dataTableIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/u,
    'Use letters, numbers and underscores, starting with a letter (64 at most).',
  );
export const dataTableNewColumnSchema = z
  .object({
    name: dataTableIdentifierSchema,
    type: z.enum(['text', 'number', 'boolean', 'date', 'json']),
    required: z.boolean().default(false),
  })
  .strict();
export type DataTableNewColumn = z.infer<typeof dataTableNewColumnSchema>;
export const dataTableColumnSchema = dataTableNewColumnSchema.extend({
  id: dataTableIdentifierSchema,
});
export type DataTableColumn = z.infer<typeof dataTableColumnSchema>;
export const dataTableNewColumnsSchema = z
  .array(dataTableNewColumnSchema)
  .min(1)
  .max(DATA_TABLE_LIMITS.maxColumns)
  .refine(
    (columns) =>
      new Set(columns.map((column) => column.name)).size === columns.length,
    'Column names must be unique',
  );
export const dataTableColumnsSchema = z
  .array(dataTableColumnSchema)
  .min(1)
  .max(DATA_TABLE_LIMITS.maxColumns)
  .refine(
    (columns) =>
      new Set(columns.map((column) => column.name)).size === columns.length &&
      new Set(columns.map((column) => column.id)).size === columns.length,
    'Column names and IDs must be unique',
  );
export const dataTableBindingsSchema = z
  .record(dataTableIdentifierSchema, dataTableIdentifierSchema)
  .refine(
    (bindings) =>
      Object.keys(bindings).length <= DATA_TABLE_LIMITS.maxColumns &&
      new Set(Object.values(bindings)).size === Object.keys(bindings).length,
    'Bind each column once, within the column limit',
  );
export type DataTableBindings = z.infer<typeof dataTableBindingsSchema>;
export const dataTableConfigSchema = z
  .object({
    table: dataTableNameSchema,
    columnBindings: dataTableBindingsSchema.optional(),
  })
  .strict();
export type DataTableConfig = z.infer<typeof dataTableConfigSchema>;
export const dataTableValueStructuralSchema = z.json();
export const dataTableValuesStructuralSchema = z.record(
  z.string(),
  dataTableValueStructuralSchema,
);
const boundedTableJson = z.unknown().superRefine((value, context) => {
  const checked = inspectBoundedJson(value, DATA_TABLE_JSON_LIMITS);
  if (!checked.ok)
    context.addIssue({
      code: 'custom',
      message:
        'A row or filter value must fit 64 KiB and bounded JSON. Split large values.',
    });
});
export const dataTableValueSchema = boundedTableJson.pipe(
  dataTableValueStructuralSchema,
);
export const dataTableValuesSchema = boundedTableJson.pipe(
  dataTableValuesStructuralSchema,
);
export type DataTableValues = z.infer<typeof dataTableValuesSchema>;
export const dataTableFilterSchema = z
  .object({
    column: dataTableIdentifierSchema,
    operator: z.enum([
      'equals',
      'not_equals',
      'contains',
      'greater_than',
      'less_than',
    ]),
    value: dataTableValueSchema,
  })
  .strict();
export const dataTableQuerySchema = z
  .object({
    filters: z.array(dataTableFilterSchema).max(10).default([]),
    sort: z
      .object({
        column: dataTableIdentifierSchema,
        direction: z.enum(['asc', 'desc']),
      })
      .strict()
      .optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(DATA_TABLE_LIMITS.batchRows)
      .default(100),
    offset: z.number().int().min(0).max(DATA_TABLE_LIMITS.maxRows).default(0),
  })
  .strict();
export type DataTableQuery = z.infer<typeof dataTableQuerySchema>;
export const dataTableCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('find'),
      table: dataTableNameSchema,
      query: dataTableQuerySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('insert'),
      table: dataTableNameSchema,
      values: dataTableValuesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('upsert'),
      table: dataTableNameSchema,
      values: dataTableValuesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('update'),
      table: dataTableNameSchema,
      query: dataTableQuerySchema,
      values: dataTableValuesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('delete'),
      table: dataTableNameSchema,
      query: dataTableQuerySchema,
    })
    .strict(),
]);
export const dataTableWriteCommandSchema = z.discriminatedUnion('operation', [
  dataTableCommandSchema.options[1],
  dataTableCommandSchema.options[2],
  dataTableCommandSchema.options[3],
  dataTableCommandSchema.options[4],
]);
export type DataTableCommand = z.infer<typeof dataTableCommandSchema>;
export const dataTableRowSchema = z
  .object({
    id: z.uuid(),
    revision: z.number().int().positive(),
    values: dataTableValuesSchema,
  })
  .strict();
export type DataTableRow = z.infer<typeof dataTableRowSchema>;
export const dataTableResultSchema = z
  .object({
    rows: z.array(dataTableRowSchema).max(DATA_TABLE_LIMITS.batchRows),
    affected: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();
export type DataTableResult = z.infer<typeof dataTableResultSchema>;
export interface NodeDataTableRuntime {
  execute(
    input: Readonly<{
      command: DataTableCommand;
      columnBindings?: DataTableBindings;
      signal: AbortSignal;
    }>,
  ): Promise<DataTableResult>;
}
export class DataTableError extends Error {
  override readonly name = 'DataTableError';
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_values'
      | 'quota_exceeded'
      | 'conflict'
      | 'key_conflict'
      | 'result_too_large'
      | 'unsafe_filter'
      | 'attempt_expired'
      | 'unavailable',
    message: string,
    readonly rowNumber?: number,
  ) {
    super(message);
  }
}

export function isDataTableResultBounded(value: DataTableResult): boolean {
  return inspectBoundedJson(value).ok;
}

export const dataTableSchemaChangeSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('add_column'),
      column: dataTableNewColumnSchema,
      defaultValue: dataTableValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('rename_column'),
      columnId: dataTableIdentifierSchema,
      name: dataTableIdentifierSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('remove_column'),
      columnId: dataTableIdentifierSchema,
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal('set_key'),
      columnId: dataTableIdentifierSchema.nullable(),
    })
    .strict(),
]);

export type DataTableSchemaChange = z.infer<typeof dataTableSchemaChangeSchema>;

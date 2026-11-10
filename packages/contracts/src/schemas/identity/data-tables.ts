import { responseSchema } from '../shared/response-schema.js';
import {
  DATA_TABLE_LIMITS,
  dataTableColumnsSchema,
  dataTableIdentifierSchema,
  dataTableNameSchema,
  dataTableNewColumnsSchema,
  dataTableQuerySchema,
  dataTableResultSchema as storedDataTableResultSchema,
  dataTableSchemaChangeSchema,
  dataTableWriteCommandSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';
export const dataTableCreateSchema = z
  .object({
    name: dataTableNameSchema,
    columns: dataTableNewColumnsSchema,
    keyColumn: dataTableIdentifierSchema.nullable().optional(),
  })
  .strict();
export const dataTableDefinitionSchema = dataTableCreateSchema
  .extend({
    id: z.uuid(),
    columns: dataTableColumnsSchema,
    hasRemovedColumns: z.boolean(),
    keyColumn: dataTableIdentifierSchema.nullable(),
    rowCount: z.number().int().nonnegative(),
    storedBytes: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
  })
  .strict();
export const dataTableLimitsSchema = z
  .object({
    tableLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxTables),
    columnLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxColumns),
    rowLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxRows),
    byteLimit: z.number().int().min(65_536).max(DATA_TABLE_LIMITS.maxBytes),
  })
  .strict();
export const dataTableQuotasSchema = responseSchema(
  dataTableLimitsSchema.extend({
    tableCount: z.number().int().nonnegative(),
    storedBytes: z.number().int().nonnegative(),
  }),
);
export const dataTablesResponseSchema = responseSchema(
  z
    .object({
      tables: z
        .array(dataTableDefinitionSchema)
        .max(DATA_TABLE_LIMITS.maxTables),
      quotas: dataTableQuotasSchema,
      unavailableTables: z
        .array(
          z
            .object({
              id: z.uuid(),
              name: dataTableNameSchema,
              reason: z.literal('data_table.stored_definition_invalid'),
            })
            .strict(),
        )
        .max(DATA_TABLE_LIMITS.maxTables)
        .optional(),
    })
    .strict(),
);
export const dataTableCreatedSchema = responseSchema(
  z.object({ id: z.uuid() }).strict(),
);
export const dataTableRemovedSchema = responseSchema(
  z.object({ removed: z.literal(true) }).strict(),
);
export const dataTableRemoveSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const dataTableWriteSchema = z.union([
  z.object({ command: dataTableWriteCommandSchema }).strict(),
  z
    .object({
      command: dataTableWriteCommandSchema,
      rowId: z.uuid(),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
]);
export const dataTableImportedSchema = responseSchema(
  z
    .object({
      affected: z.number().int().nonnegative().max(DATA_TABLE_LIMITS.batchRows),
    })
    .strict(),
);
export const dataTableCsvImportSchema = z
  .object({
    csv: z
      .string()
      .min(1, 'The CSV is empty. Add a header row and at least one row.')
      .max(1_048_576, 'CSV imports must fit 1 MB. Split the file.'),
  })
  .strict();
export { dataTableQuerySchema };
export const dataTableResultSchema = responseSchema(
  storedDataTableResultSchema,
);
export type DataTablesResponse = z.infer<typeof dataTablesResponseSchema>;
export type DataTableDefinition = z.infer<typeof dataTableDefinitionSchema>;
export type DataTableCreate = z.input<typeof dataTableCreateSchema>;
export type DataTableWrite = z.infer<typeof dataTableWriteSchema>;
export type DataTableLimits = z.infer<typeof dataTableLimitsSchema>;

export const dataTableWriteReceiptSchema = responseSchema(
  z
    .object({
      rows: z
        .array(
          z
            .object({ id: z.uuid(), revision: z.number().int().positive() })
            .strict(),
        )
        .max(1),
      affected: z.number().int().nonnegative(),
    })
    .strict(),
);

export const dataTableSchemaEditSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    change: dataTableSchemaChangeSchema,
  })
  .strict();
export const dataTableSchemaEditedSchema = responseSchema(
  z.object({ revision: z.number().int().positive() }).strict(),
);
export const dataTableExportQuerySchema = dataTableQuerySchema.omit({
  limit: true,
  offset: true,
  sort: true,
});
export type DataTableSchemaEdit = z.infer<typeof dataTableSchemaEditSchema>;
export type { DataTableSchemaChange } from '@pertexo/node-sdk';
export type DataTableExportQuery = z.infer<typeof dataTableExportQuerySchema>;

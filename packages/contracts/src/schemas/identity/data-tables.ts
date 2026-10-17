import { z } from 'zod';
import {
  DATA_TABLE_LIMITS,
  dataTableNameSchema,
  dataTableColumnsSchema,
  dataTableQuerySchema,
  dataTableWriteCommandSchema,
  dataTableResultSchema,
} from '@pertexo/node-sdk';
export const dataTableCreateSchema = z
  .object({
    name: dataTableNameSchema,
    columns: dataTableColumnsSchema,
    keyColumn: dataTableNameSchema.nullable().optional(),
  })
  .strict();
export const dataTableDefinitionSchema = dataTableCreateSchema
  .extend({
    id: z.uuid(),
    keyColumn: dataTableNameSchema.nullable(),
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
export const dataTableQuotasSchema = dataTableLimitsSchema.extend({
  tableCount: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
});
export const dataTablesResponseSchema = z
  .object({
    tables: z.array(dataTableDefinitionSchema).max(DATA_TABLE_LIMITS.maxTables),
    quotas: dataTableQuotasSchema,
  })
  .strict();
export const dataTableCreatedSchema = z.object({ id: z.uuid() }).strict();
export const dataTableRemovedSchema = z
  .object({ removed: z.literal(true) })
  .strict();
export const dataTableRemoveSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const dataTableWriteSchema = z
  .object({
    command: dataTableWriteCommandSchema,
    rowId: z.uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (input) =>
      (input.rowId === undefined) === (input.expectedRevision === undefined),
    'Row edits need the current revision',
  );
export const dataTableImportedSchema = z
  .object({
    affected: z.number().int().nonnegative().max(DATA_TABLE_LIMITS.batchRows),
  })
  .strict();
export const dataTableCsvImportSchema = z
  .object({ csv: z.string().min(1).max(1_048_576) })
  .strict();
export { dataTableQuerySchema, dataTableResultSchema };
export type DataTablesResponse = z.infer<typeof dataTablesResponseSchema>;
export type DataTableDefinition = z.infer<typeof dataTableDefinitionSchema>;
export type DataTableCreate = z.input<typeof dataTableCreateSchema>;
export type DataTableWrite = z.infer<typeof dataTableWriteSchema>;
export type DataTableLimits = z.infer<typeof dataTableLimitsSchema>;

export const dataTableWriteReceiptSchema = z
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
  .strict();
export type DataTableWriteReceipt = z.infer<typeof dataTableWriteReceiptSchema>;

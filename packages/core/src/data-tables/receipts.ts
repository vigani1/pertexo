import { DATA_TABLE_LIMITS } from '@pertexo/node-sdk';
import { z } from 'zod';

const revision = z.number().int().positive();
const count = z.number().int().nonnegative();

export const createdTableReceipt = z.object({ id: z.uuid() }).strict();

export const configuredTablesReceipt = z
  .object({
    tableLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxTables),
    columnLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxColumns),
    rowLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxRows),
    byteLimit: z.number().int().min(65_536).max(DATA_TABLE_LIMITS.maxBytes),
    tableCount: count,
    storedBytes: count,
  })
  .strict();

export const removedTableReceipt = z
  .object({ removed: z.literal(true) })
  .strict();

export const editedTableSchemaReceipt = z.object({ revision }).strict();

export const writtenTableRowsReceipt = z
  .object({
    rows: z.array(z.object({ id: z.uuid(), revision }).strict()).max(1),
    affected: count,
  })
  .strict();

export const importedTableRowsReceipt = z
  .object({ affected: count.max(DATA_TABLE_LIMITS.batchRows) })
  .strict();

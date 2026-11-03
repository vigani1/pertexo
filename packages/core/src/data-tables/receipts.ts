import { DATA_TABLE_LIMITS } from '@pertexo/node-sdk';
import { z } from 'zod';

const revision = z.number().int().positive();
const count = z.number().int().nonnegative();

export const createdTableReceipt = readableTableReceipt(
  z.object({ id: z.uuid() }).strict(),
);

export const configuredTablesReceipt = readableTableReceipt(
  z
    .object({
      tableLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxTables),
      columnLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxColumns),
      rowLimit: z.number().int().min(1).max(DATA_TABLE_LIMITS.maxRows),
      byteLimit: z.number().int().min(65_536).max(DATA_TABLE_LIMITS.maxBytes),
      tableCount: count,
      storedBytes: count,
    })
    .strict(),
);

export const removedTableReceipt = readableTableReceipt(
  z.object({ removed: z.literal(true) }).strict(),
);

export const editedTableSchemaReceipt = readableTableReceipt(
  z.object({ revision }).strict(),
);

export const writtenTableRowsReceipt = readableTableReceipt(
  z
    .object({
      rows: z.array(z.object({ id: z.uuid(), revision }).strict()).max(1),
      affected: count,
    })
    .strict(),
);

export const importedTableRowsReceipt = readableTableReceipt(
  z.object({ affected: count.max(DATA_TABLE_LIMITS.batchRows) }).strict(),
);

/** Earlier table commands replayed count-only results and retained extension fields. */
function readableTableReceipt<Shape extends z.ZodRawShape>(
  shape: z.ZodObject<Shape>,
) {
  return z.union([
    shape,
    shape
      .partial()
      .loose()
      .and(z.object({ affected: count })),
  ]);
}

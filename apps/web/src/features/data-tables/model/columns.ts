import {
  dataTableSchemaEditSchema,
  type DataTableSchemaEdit,
} from '@pertexo/contracts';
import { dataTableCsvValue, type DataTableNewColumn } from '@pertexo/node-sdk';

export type ColumnEditIntent =
  { kind: 'add' } | { kind: 'rename' | 'remove'; id: string } | { kind: 'key' };
export type ColumnEditFields = DataTableNewColumn & {
  defaultText: string;
  keyId: string;
};

export function readColumnEdit(
  expectedRevision: number,
  intent: ColumnEditIntent,
  fields: ColumnEditFields,
): DataTableSchemaEdit {
  let change: unknown;
  switch (intent.kind) {
    case 'add': {
      const column = {
        name: fields.name,
        type: fields.type,
        required: fields.required,
      };
      change = {
        operation: 'add_column',
        column,
        defaultValue: dataTableCsvValue(column, fields.defaultText),
      };
      break;
    }
    case 'rename':
      change = {
        operation: 'rename_column',
        columnId: intent.id,
        name: fields.name,
      };
      break;
    case 'remove':
      change = {
        operation: 'remove_column',
        columnId: intent.id,
        confirm: true,
      };
      break;
    case 'key':
      change = {
        operation: 'set_key',
        columnId: fields.keyId === '' ? null : fields.keyId,
      };
      break;
  }
  const parsed = dataTableSchemaEditSchema.safeParse({
    expectedRevision,
    change,
  });
  if (!parsed.success)
    throw new Error(
      parsed.error.issues[0]?.message ?? 'Check the column settings.',
    );
  return parsed.data;
}

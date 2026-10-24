import {
  workspaceVariableValuesSchema,
  workspaceVariableDescriptionsSchema,
  type WorkspaceVariableValues,
} from '@pertexo/workflow-model';
export type VariableRow = Readonly<{
  id: string;
  name: string;
  type: 'text' | 'number' | 'boolean';
  value: string;
  description: string;
}>;
export function variableRows(
  values: WorkspaceVariableValues,
  descriptions: Readonly<Record<string, string>> = {},
): VariableRow[] {
  return Object.entries(values).map(([name, value]) => ({
    id: crypto.randomUUID(),
    name,
    type: variableType(value),
    value: String(value),
    description: descriptions[name] ?? '',
  }));
}

function variableType(value: string | number | boolean): VariableRow['type'] {
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  return 'text';
}
export function readVariableRows(rows: readonly VariableRow[]):
  | Readonly<{
      values: WorkspaceVariableValues;
      descriptions: Readonly<Record<string, string>>;
      error?: never;
    }>
  | Readonly<{ values?: never; descriptions?: never; error: string }> {
  const values: Record<string, string | number | boolean> = Object.create(
    null,
  ) as Record<string, string | number | boolean>;
  for (const row of rows) {
    if (Object.hasOwn(values, row.name))
      return {
        error: `${row.name} appears more than once. Choose a unique name.`,
      };
    if (
      row.type === 'number' &&
      (row.value.trim() === '' || !Number.isFinite(Number(row.value)))
    )
      return {
        error: `Enter a finite number for ${row.name || 'this variable'}.`,
      };
    values[row.name] = rowValue(row);
  }
  const parsed = workspaceVariableValuesSchema.safeParse(values);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      error:
        first?.code === 'invalid_key'
          ? 'Names start with an uppercase letter and use uppercase letters, digits or underscores.'
          : (first?.message ?? 'Check the variable values.'),
    };
  }
  const descriptions = workspaceVariableDescriptionsSchema.safeParse(
    Object.fromEntries(
      rows
        .filter((row) => row.description.trim() !== '')
        .map((row) => [row.name, row.description]),
    ),
  );
  if (!descriptions.success)
    return {
      error:
        descriptions.error.issues[0]?.message ??
        'Check the variable descriptions.',
    };
  return { values: parsed.data, descriptions: descriptions.data };
}

export const VARIABLE_TYPE_LABELS: Readonly<
  Record<VariableRow['type'], string>
> = { text: 'Text', number: 'Number', boolean: 'True / false' };

/** The value on one line, as a summary row shows it. */
export function valuePreview(row: VariableRow): string {
  if (row.type === 'boolean') return row.value === 'true' ? 'True' : 'False';
  if (row.type === 'number') return row.value;
  return row.value === '' ? 'Empty' : row.value.replace(/\s*\n\s*/gu, ' ⏎ ');
}

/** Whether a row holds the filter text in its name, value or description. */
export function variableMatches(row: VariableRow, filter: string): boolean {
  const wanted = filter.trim().toLowerCase();
  return (
    wanted === '' ||
    [row.name, row.value, row.description].some((text) =>
      text.toLowerCase().includes(wanted),
    )
  );
}

/** Whether a row differs from what the workspace last saved. */
export function variableUnsaved(
  row: VariableRow,
  saved: Readonly<{
    values: WorkspaceVariableValues;
    descriptions: Readonly<Record<string, string>>;
  }>,
): boolean {
  const value = Object.hasOwn(saved.values, row.name)
    ? saved.values[row.name]
    : undefined;
  return (
    value === undefined ||
    variableType(value) !== row.type ||
    String(value) !== row.value ||
    (saved.descriptions[row.name] ?? '') !== row.description
  );
}

function rowValue(row: VariableRow): string | number | boolean {
  if (row.type === 'number') return Number(row.value);
  if (row.type === 'boolean') return row.value === 'true';
  return row.value;
}

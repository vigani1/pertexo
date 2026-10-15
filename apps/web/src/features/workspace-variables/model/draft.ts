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
    type:
      typeof value === 'number'
        ? 'number'
        : typeof value === 'boolean'
          ? 'boolean'
          : 'text',
    value: String(value),
    description: descriptions[name] ?? '',
  }));
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
    values[row.name] =
      row.type === 'number'
        ? Number(row.value)
        : row.type === 'boolean'
          ? row.value === 'true'
          : row.value;
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

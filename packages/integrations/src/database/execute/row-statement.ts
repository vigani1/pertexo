import {
  conflictColumns,
  type DatabaseConfig,
  type DatabaseInput,
} from './execute.schemas.js';

type WriteConfig = Exclude<DatabaseConfig, { operation: 'query' }>;

export function rowStatement(
  config: WriteConfig,
  row: NonNullable<DatabaseInput['rows']>[number],
) {
  const entries = Object.entries(row);
  if (entries.length === 0) return undefined;
  const columns = entries.map(([column]) => column);
  const values = entries.map(([, value]) => value);
  const names = columns.map(quoteIdentifier);
  const placeholders = values.map((_value, index) => parameter(index + 1));
  const table = `${quoteIdentifier(config.schema)}.${quoteIdentifier(config.table)}`;
  const insert = `insert into ${table} (${names.join(', ')}) values (${placeholders.join(', ')})`;

  switch (config.operation) {
    case 'insert':
      return { columns, text: `${insert} returning *`, values };
    case 'update': {
      const key = entries.find(([name]) => name === config.key)?.[1];
      if (key === null || key === undefined) return undefined;
      const changes = entries.filter(([name]) => name !== config.key);
      if (changes.length === 0) return undefined;
      const assignments = changes.map(
        ([name], index) => `${quoteIdentifier(name)} = ${parameter(index + 1)}`,
      );
      return {
        columns,
        text: `update ${table} set ${assignments.join(', ')} where ${quoteIdentifier(config.key)} = ${parameter(changes.length + 1)} returning *`,
        values: [...changes.map(([, value]) => value), key],
      };
    }
    case 'upsert': {
      const keys = conflictColumns(config.keys);
      if (keys.some((key) => !columns.includes(key))) return undefined;
      const keySet = new Set(keys);
      const conflict = keys.map(quoteIdentifier).join(', ');
      const updated = columns
        .filter((column) => !keySet.has(column))
        .map(quoteIdentifier);
      const action =
        updated.length === 0
          ? 'nothing'
          : `update set ${updated.map((name) => `${name} = excluded.${name}`).join(', ')}`;
      return {
        columns,
        text: `${insert} on conflict (${conflict}) do ${action} returning *`,
        values,
      };
    }
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parameter(index: number): string {
  return `$${String(index)}`;
}

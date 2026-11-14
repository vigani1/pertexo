import { describe, expect, it } from 'vitest';
import { DATA_TABLE_LIMITS } from '@pertexo/node-sdk';
import { DATA_TABLE_DEFINITIONS } from '../../../src/data/tables/data-tables.definition.js';

function inputSchemaOf(key: string) {
  const registration = DATA_TABLE_DEFINITIONS.find(
    (candidate) => candidate.manifest.definition.key === key,
  );
  if (registration === undefined) throw new TypeError(`${key} is not defined`);
  return registration.inputSchema;
}

describe('data-table steps without a query', () => {
  it.each(['core.table_find', 'core.table_update', 'core.table_delete'])(
    '%s reads the data-table default page of rows from the start',
    (key) => {
      const values = key === 'core.table_update' ? { values: {} } : {};
      expect(inputSchemaOf(key).parse(values)).toMatchObject({
        query: {
          filters: [],
          limit: DATA_TABLE_LIMITS.defaultQueryRows,
          offset: 0,
        },
      });
    },
  );
});

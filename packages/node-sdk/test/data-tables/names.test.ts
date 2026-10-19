import { describe, expect, it } from 'vitest';

import {
  dataTableCommandSchema,
  dataTableIdentifierSchema,
  dataTableNameSchema,
} from '../../src/index.js';

describe('data table names', () => {
  it('lets a table name hold words, as people write them', () => {
    for (const name of [
      'Customer orders',
      'Q4-2026 leads',
      'orders_v2',
      '2026',
    ])
      expect(dataTableNameSchema.parse(name)).toBe(name);
    expect(dataTableNameSchema.parse('  Customer orders ')).toBe(
      'Customer orders',
    );
    for (const name of ['', ' ', '-orders', 'orders!', 'Zoë', 'x'.repeat(65)])
      expect(dataTableNameSchema.safeParse(name).success).toBe(false);
  });

  it('keeps column names to identifiers', () => {
    expect(dataTableIdentifierSchema.safeParse('order_id').success).toBe(true);
    expect(dataTableIdentifierSchema.safeParse('order id').success).toBe(false);
  });

  it('finds a table by a name with spaces', () => {
    expect(
      dataTableCommandSchema.parse({
        operation: 'find',
        table: 'Customer orders',
        query: {},
      }),
    ).toMatchObject({ table: 'Customer orders' });
  });
});

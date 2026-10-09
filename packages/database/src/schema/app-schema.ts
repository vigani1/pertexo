import { customType, pgSchema } from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

/** Raw binary column; drizzle-orm 0.45 has no built-in bytea builder. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Text compared byte-wise; drizzle-orm 0.45 cannot declare column collations. */
export const textC = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"',
});

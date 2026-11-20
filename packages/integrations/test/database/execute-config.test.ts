import { expect, it } from 'vitest';
import { DATABASE_DEFINITION_REGISTRATION } from '../../src/index.js';

const config = { operation: 'upsert', schema: 'public', table: 'contacts' };

it.each([
  ['an empty value', ''],
  ['an empty line', 'email\n\naccount'],
  ['duplicate columns', 'email\nemail'],
  ['a column name over the identifier limit', 'a'.repeat(64)],
  [
    'too many columns',
    Array.from({ length: 33 }, (_, i) => `column_${String(i)}`).join('\n'),
  ],
])(
  'rejects upsert conflict columns with %s during setup validation',
  (_reason, keys) => {
    const result = DATABASE_DEFINITION_REGISTRATION.configSchema.safeParse({
      ...config,
      keys,
    });
    expect(result.success).toBe(false);
  },
);

it('preserves the authored upsert conflict columns as text', () => {
  const keys = 'Account ID\r\nEmail Address';
  const saved = { ...config, keys };
  expect(DATABASE_DEFINITION_REGISTRATION.configSchema.parse(saved)).toEqual(
    saved,
  );
});

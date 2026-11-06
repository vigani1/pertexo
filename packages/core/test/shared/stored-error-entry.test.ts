import { expect, it } from 'vitest';
import { decodeStoredValue } from '../../dist/shared/stored-values.js';

it('classifies the original stored error through the shared public entry', async () => {
  const { isStoredDataError } = await import('@pertexo/core/shared');
  const failure = new Error('unreadable stored value');
  expect(() =>
    decodeStoredValue(() => {
      throw failure;
    }),
  ).toThrow(failure);
  expect(isStoredDataError(failure)).toBe(true);
  expect(isStoredDataError(new Error('caller input'))).toBe(false);
});

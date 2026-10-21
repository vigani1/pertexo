import { describe, expect, it } from 'vitest';
import { saveRunValuesInputSchema } from '../../src/run-values/contract.js';

describe('bounded run values', () => {
  it('preserves exact business text, empty values, case and maximum lengths', () => {
    const values = {
      'Order.id-1': ' A-1042 ',
      empty: '',
      ['a'.repeat(50)]: '€'.repeat(255),
    };
    expect(saveRunValuesInputSchema.parse({ values })).toEqual({ values });
    expect(
      saveRunValuesInputSchema.safeParse({
        values: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`key${String(i)}`, 'value']),
        ),
      }).success,
    ).toBe(true);
  });
  it.each([
    {},
    { '': 'x' },
    { '-first': 'x' },
    { 'bad key': 'x' },
    { 'bad/key': 'x' },
    { ['a'.repeat(51)]: 'x' },
    { order: 'x'.repeat(256) },
    { order: '\0' },
    { order: '\ud800' },
    { order: 12 },
    Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`key${String(i)}`, 'x']),
    ),
  ])('refuses invalid pairs without coercion', (values) => {
    expect(saveRunValuesInputSchema.safeParse({ values }).success).toBe(false);
  });
});

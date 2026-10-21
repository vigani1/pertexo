import { expect, it } from 'vitest';
import { selectOutputVariant } from '../../src/index.js';
import { outputVariantSelectionSchema } from '../../src/definitions/output-variant.js';

it('selects nested opt-in outputs without changing original presence semantics', () => {
  const selection = outputVariantSelectionSchema.parse({
    configProperty: 'pagination',
    whenPresent: 1,
    whenAbsent: 0,
    overrides: [{ configPath: ['pagination', 'outputMode'], variant: 2 }],
  });
  expect(selectOutputVariant(selection, {})).toBe(0);
  expect(selectOutputVariant(selection, { pagination: { mode: 'page' } })).toBe(
    1,
  );
  expect(
    selectOutputVariant(selection, {
      pagination: { mode: 'page', outputMode: 'pages' },
    }),
  ).toBe(2);
  expect(selectOutputVariant(selection, { pagination: null })).toBe(1);
  expect(selectOutputVariant(selection, { pagination: [] })).toBe(1);
  expect(
    selectOutputVariant(selection, {
      pagination: Object.create({ outputMode: 'pages' }) as object,
    }),
  ).toBe(1);
});

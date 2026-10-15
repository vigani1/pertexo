import { expect, it } from 'vitest';
import {
  formFieldsSchema,
  formConfigSchema,
  parseFormValues,
  FormValuesInvalidError,
  inputRequestConfigSchema,
} from '../../src/index.js';
const fields = formFieldsSchema.parse(
  [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'textarea', required: false },
    { name: 'amount', label: 'Amount', type: 'number' },
    { name: 'checked', label: 'Checked', type: 'boolean' },
    {
      name: 'currency',
      label: 'Currency',
      type: 'select',
      options: ['USD', 'EUR'],
    },
    { name: 'date', label: 'Date', type: 'date' },
  ].map((field, index) => ({ ...field, id: `field-${String(index)}` })),
);
const values = {
  name: '  Alice  ',
  amount: 0,
  checked: false,
  currency: 'EUR',
  date: '2024-02-29',
};
it('preserves text, zero and false, omitting optional blank fields', () => {
  expect(parseFormValues(fields, { ...values, notes: '   ' })).toEqual(values);
  expect(formConfigSchema.parse({}).fields[0]?.required).toBe(true);
});
it.each([
  { amount: '12' },
  { checked: 'false' },
  { date: '2023-02-29' },
  { currency: 'GBP' },
  { name: ' ' },
  { amount: Infinity },
  { extra: 'unexpected' },
  { notes: { file: 'secret' } },
])('refuses invalid values without echoing their contents (%j)', (override) => {
  expect(() => parseFormValues(fields, { ...values, ...override })).toThrow(
    FormValuesInvalidError,
  );
});
it('bounds text and the total normalized response', () => {
  expect(() =>
    parseFormValues(fields, { ...values, name: 'x'.repeat(10001) }),
  ).toThrow();
  const many = formFieldsSchema.parse(
    Array.from({ length: 20 }, (_, n) => ({
      id: `field-${String(n)}`,
      name: `field${String(n)}`,
      label: 'Text',
      type: 'text',
    })),
  );
  expect(() =>
    parseFormValues(
      many,
      Object.fromEntries(many.map(({ name }) => [name, 'x'.repeat(4000)])),
    ),
  ).toThrow(/form fields/u);
});
it('rejects duplicate and unsafe field names and options', () => {
  for (const name of [
    '__proto__',
    'constructor',
    'prototype',
    'a.b',
    'bad name',
  ])
    expect(
      formFieldsSchema.safeParse([
        { id: 'field-1', name, label: 'Text', type: 'text' },
      ]).success,
    ).toBe(false);
  expect(
    formFieldsSchema.safeParse([
      { id: 'field-1', name: 'a', label: 'A', type: 'text' },
      { id: 'field-2', name: 'a', label: 'Again', type: 'number' },
    ]).success,
  ).toBe(false);
  expect(
    formFieldsSchema.safeParse([
      {
        id: 'field-1',
        name: 'a',
        label: 'Select',
        type: 'select',
        options: ['x', 'x'],
      },
    ]).success,
  ).toBe(false);
});

it('keeps field identities unique and bounds escaped task configuration', () => {
  expect(
    formFieldsSchema.safeParse([
      { id: 'same', name: 'a', label: 'A', type: 'text' },
      { id: 'same', name: 'b', label: 'B', type: 'text' },
    ]).success,
  ).toBe(false);
  expect(
    formFieldsSchema.safeParse([
      {
        id: 'select',
        name: 'a',
        label: 'A',
        type: 'select',
        options: ['one\ntwo'],
      },
    ]).success,
  ).toBe(false);
  const many = Array.from({ length: 20 }, (_, n) => ({
    id: `field-${String(n)}`,
    name: `field${String(n)}`,
    label: 'Text',
    help: 'x'.repeat(290),
    type: 'text',
  }));
  expect(formFieldsSchema.safeParse(many).success).toBe(true);
  expect(
    inputRequestConfigSchema.safeParse({
      fields: many,
      instructions: '\u0000'.repeat(2000),
    }).success,
  ).toBe(false);
});

it('accepts emoji and refuses text PostgreSQL JSON cannot store before admission', () => {
  expect(parseFormValues(fields, { ...values, name: '😀' }).name).toBe('😀');
  for (const name of ['bad\u0000text', '\ud800'])
    expect(() => parseFormValues(fields, { ...values, name })).toThrow(
      FormValuesInvalidError,
    );
});

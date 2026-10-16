import { expect, it } from 'vitest';
import {
  formFieldsSchema,
  parseTaskPrefill,
  taskDetailsSchema,
  taskContextSchema,
} from '../../src/index.js';

it('accepts named scalar facts, preserving zero, false and valid Unicode', () => {
  const details = { Amount: 0, Ready: false, Note: 'Café 🧵', Missing: null };
  expect(taskDetailsSchema.parse(details)).toEqual(details);
  expect(taskContextSchema.parse({})).toEqual({});
});
it('refuses oversized, nested, unsafe-text or excessive detail fields', () => {
  for (const details of [
    { Note: 'x'.repeat(8_193) },
    { Payload: { secret: 'not a scalar' } },
    { Note: '\0' },
    Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `Field ${String(index)}`,
        index,
      ]),
    ),
    { Note: '\n'.repeat(4_096) },
  ])
    expect(taskDetailsSchema.safeParse(details).success).toBe(false);
});
const fields = formFieldsSchema.parse([
  { id: 'a', name: 'amount', label: 'Amount', type: 'number' },
  { id: 'b', name: 'ready', label: 'Ready', type: 'boolean' },
  {
    id: 'c',
    name: 'choice',
    label: 'Choice',
    type: 'select',
    options: ['A', 'B'],
  },
]);
it('validates partial typed prefills without requiring a complete response', () => {
  expect(parseTaskPrefill(fields, {})).toEqual({});
  expect(parseTaskPrefill(fields, { amount: 0, ready: false })).toEqual({
    amount: 0,
    ready: false,
  });
  for (const prefill of [
    { amount: '0' },
    { ready: 'false' },
    { choice: 'C' },
    { foreign: 1 },
  ])
    expect(() => parseTaskPrefill(fields, prefill)).toThrow(
      'Check the form fields',
    );
});

it('captures bounded lists of plain facts without accepting nested data', () => {
  const details = { Items: ['A', 0, false, null, 'Café 🧵'], Empty: [] };
  expect(taskDetailsSchema.parse(details)).toEqual(details);
  expect(
    taskDetailsSchema.safeParse({
      Items: Array.from({ length: 20 }, () => 'x'),
    }).success,
  ).toBe(true);
  for (const invalid of [
    Array.from({ length: 21 }, () => 1),
    [[1]],
    [{ value: 1 }],
    ['\0'],
    ['x'.repeat(8192)],
  ])
    expect(taskDetailsSchema.safeParse({ Items: invalid }).success).toBe(false);
});

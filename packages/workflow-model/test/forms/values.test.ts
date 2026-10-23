import { expect, it } from 'vitest';
import {
  formFieldsSchema,
  formConfigSchema,
  parseFormValues,
  FormValuesInvalidError,
  inputRequestConfigSchema,
  formThankYouMessageSchema,
  formSubmissionSchema,
  parseTaskPrefill,
  DEFAULT_FORM_THANK_YOU_MESSAGE,
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
it.each([
  [{ name: undefined }, 'name', 'This field is required.'],
  [{ amount: '12' }, 'amount', 'Enter a number.'],
  [{ currency: 'GBP' }, 'currency', 'Choose an available option.'],
  [{ date: '19/10/2026' }, 'date', 'Enter a date like 2026-10-19.'],
  [{ name: ' ' }, 'name', 'Enter a value.'],
  [{ name: 'x'.repeat(10001) }, 'name', 'Keep this to 10000 characters.'],
] as const)(
  'says what is wrong with each field (%j)',
  (override, name, message) => {
    let error: unknown;
    try {
      // As sent over HTTP: a missing field is absent.
      parseFormValues(
        fields,
        JSON.parse(JSON.stringify({ ...values, ...override })),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FormValuesInvalidError);
    expect((error as FormValuesInvalidError).fields).toContainEqual({
      name,
      message,
    });
  },
);
it('accepts only a tick for a must-be-ticked box, and either answer otherwise', () => {
  const consent = formFieldsSchema.parse([
    {
      id: 'agree',
      name: 'agree',
      label: 'I agree',
      type: 'boolean',
      mustBeTicked: true,
    },
    { id: 'urgent', name: 'urgent', label: 'Urgent', type: 'boolean' },
  ]);
  expect(parseFormValues(consent, { agree: true, urgent: false })).toEqual({
    agree: true,
    urgent: false,
  });
  let error: unknown;
  try {
    parseFormValues(consent, { agree: false, urgent: false });
  } catch (caught) {
    error = caught;
  }
  expect((error as FormValuesInvalidError).fields).toEqual([
    { name: 'agree', message: 'Tick this box to continue.' },
  ]);
  expect(
    formFieldsSchema.safeParse([
      {
        id: 'name',
        name: 'name',
        label: 'Name',
        type: 'text',
        mustBeTicked: true,
      },
    ]).success,
  ).toBe(false);
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
  ).toThrow('Keep the form response within 64 KB.');
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

it('preserves legacy setup and bounds an optional plain acceptance message', () => {
  expect(DEFAULT_FORM_THANK_YOU_MESSAGE).toBe('Thanks for your response.');
  expect(formConfigSchema.parse({})).not.toHaveProperty('thankYouMessage');
  expect(
    formConfigSchema.parse({ thankYouMessage: '  Thanks 🧵  ' })
      .thankYouMessage,
  ).toBe('Thanks 🧵');
  expect(formThankYouMessageSchema.parse('x'.repeat(1000))).toHaveLength(1000);
  for (const message of ['', ' ', 'x'.repeat(1001), 'bad\0text', '\ud800'])
    expect(formThankYouMessageSchema.safeParse(message).success).toBe(false);
  expect(
    inputRequestConfigSchema.safeParse({ thankYouMessage: 'Not for tasks' })
      .success,
  ).toBe(false);
});
const multiple = formFieldsSchema.parse([
  {
    id: 'required',
    name: 'channels',
    label: 'Channels',
    type: 'multi_select',
    options: ['Email', 'SMS'],
  },
  {
    id: 'optional',
    name: 'extras',
    label: 'Extras',
    type: 'multi_select',
    required: false,
    options: ['A', 'B'],
  },
  { id: 'text', name: 'note', label: 'Note', type: 'text', required: false },
]);
it('keeps ordered unique choices and omits optional empty arrays, including partial prefills', () => {
  const values = { channels: ['SMS', 'Email'] };
  expect(parseFormValues(multiple, { ...values, extras: [] })).toEqual(values);
  expect(parseTaskPrefill(multiple, { channels: [], extras: ['B'] })).toEqual({
    extras: ['B'],
  });
  expect(
    formSubmissionSchema.parse({
      values,
      submittedBy: null,
      submittedAt: '2026-10-16T00:00:00.000Z',
    }).values,
  ).toEqual(values);
});
it.each([
  [],
  ['Email', 'Email'],
  ['Other'],
  'Email',
  '',
  false,
  [1],
  Array.from({ length: 51 }, () => 'Email'),
])('refuses malformed or unavailable multiple choices (%j)', (value) => {
  expect(() => parseFormValues(multiple, { channels: value })).toThrow(
    FormValuesInvalidError,
  );
});
it('does not coerce arrays into empty optional text or strings into optional choices', () => {
  expect(() =>
    parseFormValues(multiple, { channels: ['Email'], note: [] }),
  ).toThrow(FormValuesInvalidError);
  expect(() =>
    parseFormValues(multiple, { channels: ['Email'], extras: '' }),
  ).toThrow(FormValuesInvalidError);
});
it('retains the response budget with multiple choices and otherwise valid text', () => {
  const options = Array.from(
    { length: 50 },
    (_, i) => `${String(i)}${'x'.repeat(158)}`,
  );
  const fields = formFieldsSchema.parse([
    {
      id: 'choices',
      name: 'choices',
      label: 'Choices',
      type: 'multi_select',
      options,
    },
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `f${String(i)}`,
      name: `f${String(i)}`,
      label: 'Text',
      type: 'text',
    })),
  ]);
  expect(() =>
    parseFormValues(fields, {
      choices: options,
      ...Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [
          `f${String(i)}`,
          'x'.repeat(9000),
        ]),
      ),
    }),
  ).toThrow('Keep the form response within 64 KB.');
});

it('enforces per-field selection bounds while allowing partial requested prefills', () => {
  const bounded = formFieldsSchema.parse([
    {
      id: 'choices',
      name: 'choices',
      label: 'Choices',
      type: 'multi_select',
      options: ['A', 'B', 'C'],
      minSelections: 2,
      maxSelections: 2,
    },
  ]);
  expect(parseFormValues(bounded, { choices: ['B', 'A'] })).toEqual({
    choices: ['B', 'A'],
  });
  for (const value of [[], ['A'], ['A', 'B', 'C'], ['A', 'A']])
    expect(() => parseFormValues(bounded, { choices: value })).toThrow(
      FormValuesInvalidError,
    );
  expect(parseTaskPrefill(bounded, { choices: ['A'] })).toEqual({
    choices: ['A'],
  });
  expect(() =>
    parseTaskPrefill(bounded, { choices: ['A', 'B', 'C'] }),
  ).toThrow();
  const optional = bounded.map((field) => ({ ...field, required: false }));
  expect(parseFormValues(optional, { choices: [] })).toEqual({});
  expect(() => parseFormValues(optional, { choices: ['A'] })).toThrow();
  for (const overrides of [
    { minSelections: 3, maxSelections: 1 },
    { minSelections: 4 },
    { maxSelections: 4 },
    { minSelections: -1 },
    { maxSelections: 0 },
    { maxSelections: 1.5 },
  ])
    expect(
      formFieldsSchema.safeParse([{ ...bounded[0], ...overrides }]).success,
    ).toBe(false);
});
it('retains old form configuration exactly and accepts only credential-free HTTPS redirects', () => {
  const legacy = formConfigSchema.parse({});
  expect(legacy).not.toHaveProperty('redirectUrl');
  expect(
    formConfigSchema.parse({
      redirectUrl: 'https://example.test/thanks?campaign=form',
    }).redirectUrl,
  ).toBe('https://example.test/thanks?campaign=form');
  for (const url of [
    'http://example.test/',
    'javascript:alert(1)',
    'data:text/html,bad',
    '//example.test/',
    'https://user:pass@example.test/',
    'https://example.test/\0',
    'https://example.test/\uD800',
  ])
    expect(formConfigSchema.safeParse({ redirectUrl: url }).success).toBe(
      false,
    );
  expect(
    inputRequestConfigSchema.safeParse({ redirectUrl: 'https://example.test/' })
      .success,
  ).toBe(false);
});

it.each(['toString', 'valueOf', 'hasOwnProperty'])(
  'reads only own submitted values for form field %s',
  (name) => {
    const optional = formFieldsSchema.parse([
      { id: 'field', name, label: 'Value', type: 'text', required: false },
    ]);
    expect(parseFormValues(optional, {})).toEqual({});
    expect(parseFormValues(optional, { [name]: 'supplied' })).toEqual({
      [name]: 'supplied',
    });
    expect(parseFormValues(optional, { [name]: '' })).toEqual({});
    const required = formFieldsSchema.parse([
      { id: 'field', name, label: 'Value', type: 'text', required: true },
    ]);
    let failure: unknown;
    try {
      parseFormValues(required, {});
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FormValuesInvalidError);
    expect((failure as FormValuesInvalidError).fields).toEqual([
      { name, message: 'This field is required.' },
    ]);
  },
);

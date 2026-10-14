import type { SchemaFieldSpec } from '../draft';

type FieldWords = Pick<SchemaFieldSpec, 'optionLabels' | 'description'>;
const words: Readonly<Record<string, Readonly<Record<string, FieldWords>>>> = {
  'core.filter': {
    path: {
      description:
        'Use $ for each whole item, or a path like $.paid for one field.',
    },
    operator: {
      optionLabels: {
        equals: 'Equals',
        not_equals: 'Does not equal',
        less_than: 'Less than',
        less_or_equal: 'Less than or equal',
        greater_than: 'Greater than',
        greater_or_equal: 'Greater than or equal',
        contains: 'Contains text',
        exists: 'Field exists',
        not_exists: 'Field is missing',
      },
    },
  },
  'core.sort': {
    path: {
      description:
        'Use $ for each whole item, or a path like $.amount for one field.',
    },
    valueType: {
      optionLabels: { number: 'Numbers', text: 'Text' },
      description:
        'Numbers sort numerically. Text compares characters in a fixed, case-sensitive order.',
    },
    direction: {
      optionLabels: { ascending: 'Ascending', descending: 'Descending' },
    },
    missing: { optionLabels: { first: 'First', last: 'Last' } },
  },
  'core.unique': {
    path: {
      description:
        'Use $ to compare whole items, or a field like $.id. Keep the first item for each equal value.',
    },
    missing: {
      optionLabels: {
        error: 'Fail on missing keys',
        skip: 'Skip missing keys',
      },
    },
  },
  'core.summarize': {
    valuePath: {
      description:
        'Choose numeric items with $, or a field like $.amount. Text numbers need conversion in an expression first.',
    },
    groupBy: {
      description:
        'Leave empty for one total, or group by a field like $.currency. Groups keep their first-seen order.',
    },
    missing: {
      optionLabels: {
        error: 'Fail on missing values',
        skip: 'Skip missing values',
      },
    },
  },
  'core.date': {
    format: {
      optionLabels: {
        date_only: 'Date only (YYYY-MM-DD)',
        date_time: 'Date and time (YYYY-MM-DD HH:mm:ss)',
        iso: 'ISO timestamp with offset',
      },
    },
    unit: {
      optionLabels: {
        minutes: 'Minutes',
        hours: 'Hours',
        days: 'Days (24 hours)',
        weeks: 'Weeks (168 hours)',
        months: 'Calendar months (UTC)',
      },
    },
    operation: {
      optionLabels: {
        to_iso: 'ISO timestamp (UTC)',
        to_epoch_millis: 'Epoch milliseconds',
        format: 'Format timestamp',
        convert_timezone: 'Convert time zone',
        add_duration: 'Add or subtract duration',
      },
    },
  },
};

/** Display words preserve schema choices, bounds and exact saved version pins. */
export function describeTransformFields(
  fields: readonly SchemaFieldSpec[],
  definitionKey: string,
): readonly SchemaFieldSpec[] {
  const presentation = words[definitionKey];
  if (presentation === undefined) return fields;
  return fields.map((field) => {
    const override = presentation[field.key];
    return override === undefined ? field : { ...field, ...override };
  });
}

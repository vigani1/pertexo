import { CORE_VALIDATE_CONFIG_SCHEMA } from '../../src/index.js';
import { createCoreNodeRegistry } from '../../src/server.js';
export const registry = createCoreNodeRegistry();
export function config(rules: readonly Record<string, unknown>[]) {
  return CORE_VALIDATE_CONFIG_SCHEMA.parse({ rules });
}
export const invalidCases: readonly [unknown, string][] = [
  [{ rules: [] }, 'at least one rule'],
  [{ rules: [{ id: '1bad', path: '$' }] }, 'rule ID must start with a letter'],
  [{ rules: [{ id: 'name', path: '$.*' }] }, 'wildcards are rejected'],
  [
    { rules: [{ id: 'name', path: '$.name', unknown: true }] },
    'unknown rule fields are rejected',
  ],
  [
    {
      rules: [
        { id: 'same', path: '$.first' },
        { id: 'same', path: '$.second' },
      ],
    },
    'duplicate rule IDs are rejected',
  ],
  [
    {
      rules: [{ id: 'name', path: '$.name', enum: ['x', 'x'] }],
    },
    'duplicate enum values are rejected',
  ],
  [
    {
      rules: [{ id: 'name', path: '$.name', type: 'string', minimum: 1 }],
    },
    'numeric bounds require number type',
  ],
  [
    {
      rules: [
        {
          id: 'name',
          path: '$.name',
          type: 'string',
          minLength: 3,
          maxLength: 2,
        },
      ],
    },
    'lower length bounds cannot exceed upper bounds',
  ],
  [
    {
      rules: [
        {
          id: 'value',
          path: '$.value',
          type: 'number',
          minimum: 4,
          maximum: 3,
        },
      ],
    },
    'lower numeric bounds cannot exceed upper bounds',
  ],
  [
    {
      rules: [
        {
          id: 'value',
          path: '$.value',
          type: 'string',
          enum: ['😀'.repeat(65)],
        },
      ],
    },
    'enum strings are bounded in UTF-8 bytes',
  ],
];
export const fixedIssueMetadata = [
  { code: 'required', message: 'Required value is missing.' },
  { code: 'type', message: 'Value has an unexpected type.' },
  { code: 'enum', message: 'Value is not an allowed enum member.' },
  { code: 'minimum', message: 'Number is below the minimum.' },
  { code: 'maximum', message: 'Number is above the maximum.' },
  { code: 'min_length', message: 'String is shorter than the minimum length.' },
  { code: 'max_length', message: 'String is longer than the maximum length.' },
  { code: 'min_items', message: 'Array has fewer than the minimum items.' },
  { code: 'max_items', message: 'Array has more than the maximum items.' },
] as const;

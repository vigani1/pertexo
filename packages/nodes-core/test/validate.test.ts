import { describe, expect, it } from 'vitest';
import { createRegistryRelease } from '@pertexo/node-sdk';
import {
  NodeExecutionAbortedError,
  createNodeRegistry,
} from '@pertexo/node-sdk/server';

import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_VALIDATE_CONFIG_SCHEMA,
  CORE_VALIDATE_DEFINITION,
  CORE_VALIDATE_EXECUTOR,
  CORE_VALIDATE_ISSUE_CODES,
  CORE_VALIDATE_ISSUE_MESSAGES,
  CORE_VALIDATE_ISSUE_SCHEMA,
  CORE_VALIDATE_MAX_ISSUES,
  CORE_VALIDATE_OUTPUT_SCHEMA,
  CORE_VALIDATE_RULE_SCHEMA,
  CORE_VALIDATE_VALUE_TYPES,
  type CoreValidateInput,
  evaluateCoreValidate,
} from '../src/index.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '../src/server.js';

const release = createRegistryRelease({
  epoch: 1,
  definitions: CORE_NODE_DEFINITION_REGISTRATIONS.map(
    ({ manifest }) => manifest,
  ),
  executors: CORE_NODE_EXECUTOR_REGISTRATIONS.map((registration) => ({
    abiVersion: registration.abiVersion,
    definitions: registration.definitions,
    executor: registration.executor,
    lifecycle: registration.lifecycle,
    policyReferences: registration.policyReferences,
  })),
  policies: [CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY],
});

const registry = createNodeRegistry({
  release,
  definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
  executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
});

function config(rules: readonly Record<string, unknown>[]) {
  return CORE_VALIDATE_CONFIG_SCHEMA.parse({ rules });
}

const invalidCases: readonly [unknown, string][] = [
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

describe('core.validate configuration contract', () => {
  it('accepts exact rule and enum limits and rejects the next entry', () => {
    const rules = Array.from({ length: 64 }, (_, index) => ({
      id: `rule-${String(index)}`,
      path: '$',
    }));
    expect(CORE_VALIDATE_CONFIG_SCHEMA.safeParse({ rules }).success).toBe(true);
    expect(
      CORE_VALIDATE_CONFIG_SCHEMA.safeParse({
        rules: [...rules, { id: 'extra', path: '$' }],
      }).success,
    ).toBe(false);
    const values = Array.from({ length: 32 }, (_, index) => index);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'enum',
        path: '$',
        enum: values,
      }).success,
    ).toBe(true);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'enum',
        path: '$',
        enum: [...values, 32],
      }).success,
    ).toBe(false);
  });

  it.each([
    { type: 'number', minimum: Infinity },
    { type: 'number', maximum: NaN },
    { type: 'string', minLength: -1 },
    { type: 'array', maxItems: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'array', minItems: 3, maxItems: 2 },
    { type: 'number', enum: ['1'] },
    { type: 'object', enum: [null] },
  ])('rejects incoherent rule limits %j', (constraint) => {
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'bounded',
        path: '$',
        ...constraint,
      }).success,
    ).toBe(false);
  });
  it('accepts the bounded rule vocabulary and defaults required to false', () => {
    expect(
      CORE_VALIDATE_CONFIG_SCHEMA.parse({
        rules: [{ id: 'name', path: '$.name' }],
      }),
    ).toEqual({
      rules: [{ id: 'name', path: '$.name', required: false }],
    });
    expect(CORE_VALIDATE_VALUE_TYPES).toEqual([
      'string',
      'number',
      'boolean',
      'object',
      'array',
      'null',
    ]);
  });

  it.each(invalidCases)('rejects %s', (candidate) => {
    expect(CORE_VALIDATE_CONFIG_SCHEMA.safeParse(candidate).success).toBe(
      false,
    );
  });

  it('rejects paths over the byte or segment bounds while preserving quoted names', () => {
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'quoted',
        path: "$['a.b'][0]['quote\\'key']",
      }).success,
    ).toBe(true);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'segments',
        path: '$' + '.segment'.repeat(65),
      }).success,
    ).toBe(false);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'bytes',
        path: '$.' + '😀'.repeat(170),
      }).success,
    ).toBe(false);
  });

  it('pins fixed issue codes and messages without observed values', () => {
    expect(CORE_VALIDATE_ISSUE_CODES).toEqual({
      required: 'required',
      type: 'type',
      enum: 'enum',
      minimum: 'minimum',
      maximum: 'maximum',
      minLength: 'min_length',
      maxLength: 'max_length',
      minItems: 'min_items',
      maxItems: 'max_items',
    });
    expect(CORE_VALIDATE_ISSUE_MESSAGES).toEqual({
      required: 'Required value is missing.',
      type: 'Value has an unexpected type.',
      enum: 'Value is not an allowed enum member.',
      minimum: 'Number is below the minimum.',
      maximum: 'Number is above the maximum.',
      minLength: 'String is shorter than the minimum length.',
      maxLength: 'String is longer than the maximum length.',
      minItems: 'Array has fewer than the minimum items.',
      maxItems: 'Array has more than the maximum items.',
    });
    expect(
      CORE_VALIDATE_ISSUE_SCHEMA.safeParse({
        ruleId: 'value',
        path: '$.value',
        code: 'required',
        message: CORE_VALIDATE_ISSUE_MESSAGES.required,
      }).success,
    ).toBe(true);
    expect(
      CORE_VALIDATE_ISSUE_SCHEMA.safeParse({
        ruleId: 'value',
        path: '$.value',
        code: 'required',
        message: CORE_VALIDATE_ISSUE_MESSAGES.type,
      }).success,
    ).toBe(false);
  });
});

describe('core.validate deterministic evaluation', () => {
  it('uses rule order and one issue per rule with documented precedence', () => {
    const parsed = config([
      { id: 'required', path: '$.missing', required: true },
      { id: 'type', path: '$.value', type: 'string', enum: ['x'] },
      { id: 'enum', path: '$.value', enum: ['other'] },
      { id: 'minimum', path: '$.number', type: 'number', minimum: 5 },
      { id: 'maximum', path: '$.number', type: 'number', maximum: 1 },
      { id: 'minLength', path: '$.text', type: 'string', minLength: 3 },
      { id: 'maxLength', path: '$.text', type: 'string', maxLength: 1 },
      { id: 'minItems', path: '$.items', type: 'array', minItems: 3 },
      { id: 'maxItems', path: '$.items', type: 'array', maxItems: 0 },
    ]);
    expect(
      evaluateCoreValidate(parsed, {
        value: 2,
        number: 2,
        text: '😀😀',
        items: [1, 2],
      }),
    ).toEqual({
      valid: false,
      issues: [
        {
          ruleId: 'required',
          path: '$.missing',
          code: 'required',
          message: CORE_VALIDATE_ISSUE_MESSAGES.required,
        },
        {
          ruleId: 'type',
          path: '$.value',
          code: 'type',
          message: CORE_VALIDATE_ISSUE_MESSAGES.type,
        },
        {
          ruleId: 'enum',
          path: '$.value',
          code: 'enum',
          message: CORE_VALIDATE_ISSUE_MESSAGES.enum,
        },
        {
          ruleId: 'minimum',
          path: '$.number',
          code: 'minimum',
          message: CORE_VALIDATE_ISSUE_MESSAGES.minimum,
        },
        {
          ruleId: 'maximum',
          path: '$.number',
          code: 'maximum',
          message: CORE_VALIDATE_ISSUE_MESSAGES.maximum,
        },
        {
          ruleId: 'minLength',
          path: '$.text',
          code: 'min_length',
          message: CORE_VALIDATE_ISSUE_MESSAGES.minLength,
        },
        {
          ruleId: 'maxLength',
          path: '$.text',
          code: 'max_length',
          message: CORE_VALIDATE_ISSUE_MESSAGES.maxLength,
        },
        {
          ruleId: 'minItems',
          path: '$.items',
          code: 'min_items',
          message: CORE_VALIDATE_ISSUE_MESSAGES.minItems,
        },
        {
          ruleId: 'maxItems',
          path: '$.items',
          code: 'max_items',
          message: CORE_VALIDATE_ISSUE_MESSAGES.maxItems,
        },
      ],
      truncated: false,
    });
  });

  it('distinguishes missing from null and counts Unicode code points', () => {
    const parsed = config([
      { id: 'optional', path: '$.missing', type: 'string' },
      { id: 'null', path: '$.value', type: 'null', required: true },
      { id: 'emoji', path: '$.emoji', type: 'string', minLength: 2 },
    ]);
    expect(
      evaluateCoreValidate(parsed, { value: null, emoji: '😀😀' }),
    ).toEqual({
      valid: true,
      issues: [],
      truncated: false,
    });
  });

  it('resolves root, quoted own properties and array paths without echoing input', () => {
    const parsed = config([
      { id: 'root', path: '$', type: 'object' },
      { id: 'quoted', path: "$['a.b']", type: 'number', minimum: 5 },
      { id: 'array', path: '$.items[1]', type: 'boolean', enum: [true] },
    ]);
    const input = JSON.parse(
      '{"a.b":7,"items":[false,true]}',
    ) as CoreValidateInput;
    expect(evaluateCoreValidate(parsed, input)).toEqual({
      valid: true,
      issues: [],
      truncated: false,
    });
    expect(input).toEqual({ 'a.b': 7, items: [false, true] });
  });

  it('stops at 16 issues and marks only unevaluated rules as truncated', () => {
    const rules = Array.from({ length: 17 }, (_, index) => ({
      id: `rule-${String(index)}`,
      path: `$.missing${String(index)}`,
      required: true,
    }));
    const parsed = config(rules);
    const result = evaluateCoreValidate(parsed, {});
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(CORE_VALIDATE_MAX_ISSUES);
    expect(result.truncated).toBe(true);
    expect(result.issues.at(-1)?.ruleId).toBe('rule-15');

    const exact = evaluateCoreValidate(config(rules.slice(0, 16)), {});
    expect(exact.issues).toHaveLength(CORE_VALIDATE_MAX_ISSUES);
    expect(exact.truncated).toBe(false);
  });

  it('fails with the normal cancellation contract when aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      evaluateCoreValidate(
        config([{ id: 'value', path: '$.value' }]),
        { value: true },
        controller.signal,
      ),
    ).toThrow('Validate execution was canceled');
  });
});

describe('core.validate registry execution', () => {
  it('matches the pure preview result through the public runtime registry', async () => {
    const parsed = config([
      { id: 'name', path: '$.name', required: true, type: 'string' },
      { id: 'count', path: '$.count', type: 'number', minimum: 2 },
    ]);
    const input = { name: 'preview/runtime', count: 1 };
    const expected = evaluateCoreValidate(parsed, input);
    await expect(
      registry.execute({
        config: parsed,
        definition: CORE_VALIDATE_DEFINITION,
        executor: CORE_VALIDATE_EXECUTOR,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: expected });
  });

  it('does not run a canceled invocation and uses no dispatch runtime', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      registry.execute({
        config: config([{ id: 'value', path: '$.value' }]),
        definition: CORE_VALIDATE_DEFINITION,
        executor: CORE_VALIDATE_EXECUTOR,
        input: { value: true },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(NodeExecutionAbortedError);
  });

  it('rejects inconsistent runtime output contracts', () => {
    expect(
      CORE_VALIDATE_OUTPUT_SCHEMA.safeParse({
        valid: true,
        issues: [
          {
            ruleId: 'value',
            path: '$.value',
            code: 'required',
            message: CORE_VALIDATE_ISSUE_MESSAGES.required,
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      CORE_VALIDATE_OUTPUT_SCHEMA.safeParse({
        valid: false,
        issues: [
          {
            ruleId: 'value',
            path: '$.value',
            code: 'required',
            message: CORE_VALIDATE_ISSUE_MESSAGES.required,
          },
          {
            ruleId: 'value',
            path: '$.value',
            code: 'required',
            message: CORE_VALIDATE_ISSUE_MESSAGES.required,
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
  });
});

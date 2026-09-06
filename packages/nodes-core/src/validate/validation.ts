import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { parseJsonPath } from '@pertexo/workflow-model/json-path';
import { z } from 'zod';

export const CORE_VALIDATE_MAX_RULES = 64;
export const CORE_VALIDATE_MAX_ISSUES = 16;
export const CORE_VALIDATE_MAX_PATH_BYTES = 512;
export const CORE_VALIDATE_MAX_PATH_SEGMENTS = 64;
export const CORE_VALIDATE_MAX_ENUM_VALUES = 32;
export const CORE_VALIDATE_MAX_ENUM_STRING_BYTES = 256;
export const CORE_VALIDATE_MAX_MESSAGE_BYTES = 128;

export const CORE_VALIDATE_VALUE_TYPES = Object.freeze([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
] as const);
export const CORE_VALIDATE_VALUE_TYPE_SCHEMA = z.enum(
  CORE_VALIDATE_VALUE_TYPES,
);

export const CORE_VALIDATE_ISSUE_CODES = Object.freeze({
  required: 'required',
  type: 'type',
  enum: 'enum',
  minimum: 'minimum',
  maximum: 'maximum',
  minLength: 'min_length',
  maxLength: 'max_length',
  minItems: 'min_items',
  maxItems: 'max_items',
} as const);
export const CORE_VALIDATE_ISSUE_CODE_VALUES = Object.freeze([
  'required',
  'type',
  'enum',
  'minimum',
  'maximum',
  'min_length',
  'max_length',
  'min_items',
  'max_items',
] as const);
export const CORE_VALIDATE_ISSUE_CODE_SCHEMA = z.enum(
  CORE_VALIDATE_ISSUE_CODE_VALUES,
);

export const CORE_VALIDATE_ISSUE_MESSAGES = Object.freeze({
  required: 'Required value is missing.',
  type: 'Value has an unexpected type.',
  enum: 'Value is not an allowed enum member.',
  minimum: 'Number is below the minimum.',
  maximum: 'Number is above the maximum.',
  minLength: 'String is shorter than the minimum length.',
  maxLength: 'String is longer than the maximum length.',
  minItems: 'Array has fewer than the minimum items.',
  maxItems: 'Array has more than the maximum items.',
} as const);

export const CORE_VALIDATE_PATH_SCHEMA = z
  .string()
  .min(1)
  .max(CORE_VALIDATE_MAX_PATH_BYTES)
  .superRefine((path, context) => {
    if (
      new TextEncoder().encode(path).byteLength > CORE_VALIDATE_MAX_PATH_BYTES
    )
      context.addIssue({
        code: 'custom',
        message: 'Validate paths must be at most 512 UTF-8 bytes',
      });
    const segments = parseJsonPath(path);
    if (segments === undefined)
      context.addIssue({
        code: 'custom',
        message: 'Validate path must use the platform JSON path syntax',
      });
    else if (segments.length > CORE_VALIDATE_MAX_PATH_SEGMENTS)
      context.addIssue({
        code: 'custom',
        message: 'Validate paths must contain at most 64 segments',
      });
  });

// Zod 4's number schema rejects non-finite values by default.
const finiteNumberSchema = z.number();
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const ruleIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const ruleTypeSchema = CORE_VALIDATE_VALUE_TYPE_SCHEMA;

const enumStringSchema = z
  .string()
  .max(256)
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(value).byteLength >
      CORE_VALIDATE_MAX_ENUM_STRING_BYTES
    )
      context.addIssue({
        code: 'custom',
        message: 'Enum strings must be at most 256 UTF-8 bytes',
      });
  });

export const CORE_VALIDATE_ENUM_VALUE_SCHEMA = z.union([
  z.null(),
  z.boolean(),
  finiteNumberSchema,
  enumStringSchema,
]);

function valueType(value: z.output<typeof CORE_VALIDATE_ENUM_VALUE_SCHEMA>) {
  if (value === null) return 'null' as const;
  return typeof value;
}

function scalarToken(value: z.output<typeof CORE_VALIDATE_ENUM_VALUE_SCHEMA>) {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function addConstraintTypeIssue(
  context: z.RefinementCtx,
  field:
    'minimum' | 'maximum' | 'minLength' | 'maxLength' | 'minItems' | 'maxItems',
  expectedType: (typeof CORE_VALIDATE_VALUE_TYPES)[number],
): void {
  context.addIssue({
    code: 'custom',
    path: [field],
    message: `${field} requires type ${expectedType}`,
  });
}

export const CORE_VALIDATE_RULE_SCHEMA = z
  .object({
    id: ruleIdSchema,
    path: CORE_VALIDATE_PATH_SCHEMA,
    required: z.boolean().default(false),
    type: ruleTypeSchema.optional(),
    enum: z
      .array(CORE_VALIDATE_ENUM_VALUE_SCHEMA)
      .min(1)
      .max(CORE_VALIDATE_MAX_ENUM_VALUES)
      .optional(),
    minimum: finiteNumberSchema.optional(),
    maximum: finiteNumberSchema.optional(),
    minLength: nonnegativeSafeIntegerSchema.optional(),
    maxLength: nonnegativeSafeIntegerSchema.optional(),
    minItems: nonnegativeSafeIntegerSchema.optional(),
    maxItems: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.enum !== undefined) {
      const tokens = rule.enum.map(scalarToken);
      if (new Set(tokens).size !== tokens.length)
        context.addIssue({
          code: 'custom',
          path: ['enum'],
          message: 'Validate enum values must be distinct',
        });
      if (
        rule.type !== undefined &&
        rule.enum.some((value) => valueType(value) !== rule.type)
      )
        context.addIssue({
          code: 'custom',
          path: ['enum'],
          message: 'Validate enum values must match the declared type',
        });
    }

    if (rule.minimum !== undefined && rule.type !== 'number')
      addConstraintTypeIssue(context, 'minimum', 'number');
    if (rule.maximum !== undefined && rule.type !== 'number')
      addConstraintTypeIssue(context, 'maximum', 'number');
    if (rule.minLength !== undefined && rule.type !== 'string')
      addConstraintTypeIssue(context, 'minLength', 'string');
    if (rule.maxLength !== undefined && rule.type !== 'string')
      addConstraintTypeIssue(context, 'maxLength', 'string');
    if (rule.minItems !== undefined && rule.type !== 'array')
      addConstraintTypeIssue(context, 'minItems', 'array');
    if (rule.maxItems !== undefined && rule.type !== 'array')
      addConstraintTypeIssue(context, 'maxItems', 'array');

    if (
      rule.minimum !== undefined &&
      rule.maximum !== undefined &&
      rule.minimum > rule.maximum
    )
      context.addIssue({
        code: 'custom',
        path: ['minimum'],
        message: 'Validate minimum cannot exceed maximum',
      });
    if (
      rule.minLength !== undefined &&
      rule.maxLength !== undefined &&
      rule.minLength > rule.maxLength
    )
      context.addIssue({
        code: 'custom',
        path: ['minLength'],
        message: 'Validate minLength cannot exceed maxLength',
      });
    if (
      rule.minItems !== undefined &&
      rule.maxItems !== undefined &&
      rule.minItems > rule.maxItems
    )
      context.addIssue({
        code: 'custom',
        path: ['minItems'],
        message: 'Validate minItems cannot exceed maxItems',
      });
  });

export const CORE_VALIDATE_CONFIG_SCHEMA = z
  .object({
    rules: z
      .array(CORE_VALIDATE_RULE_SCHEMA)
      .min(1)
      .max(CORE_VALIDATE_MAX_RULES),
  })
  .strict()
  .superRefine(({ rules }, context) => {
    const ids = rules.map(({ id }) => id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['rules'],
        message: 'Validate rule IDs must be unique',
      });
  });

const issueMessageSchema = z
  .string()
  .max(CORE_VALIDATE_MAX_MESSAGE_BYTES)
  .refine(
    (message) =>
      new TextEncoder().encode(message).byteLength <=
      CORE_VALIDATE_MAX_MESSAGE_BYTES,
    'Validate issue messages must be at most 128 UTF-8 bytes',
  );

const issueMessageByCode: Readonly<
  Record<
    (typeof CORE_VALIDATE_ISSUE_CODE_VALUES)[number],
    (typeof CORE_VALIDATE_ISSUE_MESSAGES)[keyof typeof CORE_VALIDATE_ISSUE_MESSAGES]
  >
> = Object.freeze({
  required: CORE_VALIDATE_ISSUE_MESSAGES.required,
  type: CORE_VALIDATE_ISSUE_MESSAGES.type,
  enum: CORE_VALIDATE_ISSUE_MESSAGES.enum,
  minimum: CORE_VALIDATE_ISSUE_MESSAGES.minimum,
  maximum: CORE_VALIDATE_ISSUE_MESSAGES.maximum,
  min_length: CORE_VALIDATE_ISSUE_MESSAGES.minLength,
  max_length: CORE_VALIDATE_ISSUE_MESSAGES.maxLength,
  min_items: CORE_VALIDATE_ISSUE_MESSAGES.minItems,
  max_items: CORE_VALIDATE_ISSUE_MESSAGES.maxItems,
});

export const CORE_VALIDATE_ISSUE_SCHEMA = z
  .object({
    ruleId: ruleIdSchema,
    path: CORE_VALIDATE_PATH_SCHEMA,
    code: CORE_VALIDATE_ISSUE_CODE_SCHEMA,
    message: issueMessageSchema,
  })
  .strict()
  .superRefine((issue, context) => {
    if (issue.message !== issueMessageByCode[issue.code])
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'Validate issue message does not match its code',
      });
  });

export const CORE_VALIDATE_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_VALIDATE_OUTPUT_SCHEMA = z
  .object({
    valid: z.boolean(),
    issues: z.array(CORE_VALIDATE_ISSUE_SCHEMA).max(CORE_VALIDATE_MAX_ISSUES),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine(({ valid, issues, truncated }, context) => {
    if (new Set(issues.map(({ ruleId }) => ruleId)).size !== issues.length)
      context.addIssue({
        code: 'custom',
        path: ['issues'],
        message:
          'Validate output issues must contain at most one issue per rule',
      });
    const expectedValid = issues.length === 0 && !truncated;
    if (valid !== expectedValid)
      context.addIssue({
        code: 'custom',
        path: ['valid'],
        message: 'Validate valid must match issues and truncation',
      });
    if (truncated && issues.length !== CORE_VALIDATE_MAX_ISSUES)
      context.addIssue({
        code: 'custom',
        path: ['truncated'],
        message: 'Validate truncation requires the issue limit',
      });
  });

export type CoreValidateConfig = Readonly<
  z.output<typeof CORE_VALIDATE_CONFIG_SCHEMA>
>;
export type CoreValidateRule = Readonly<
  z.output<typeof CORE_VALIDATE_RULE_SCHEMA>
>;
export type CoreValidateInput = z.output<typeof CORE_VALIDATE_INPUT_SCHEMA>;
export type CoreValidateIssue = z.output<typeof CORE_VALIDATE_ISSUE_SCHEMA>;
export type CoreValidateOutput = z.output<typeof CORE_VALIDATE_OUTPUT_SCHEMA>;

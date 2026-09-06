import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import { resolveJsonPath } from '@pertexo/workflow-model/json-path';

import {
  CORE_VALIDATE_ISSUE_CODES,
  CORE_VALIDATE_ISSUE_MESSAGES,
  CORE_VALIDATE_MAX_ISSUES,
  type CoreValidateConfig,
  type CoreValidateInput,
  type CoreValidateIssue,
  type CoreValidateOutput,
  type CoreValidateRule,
} from './validation.js';

export class CoreValidateExecutionAbortedError extends Error {
  public override readonly name = 'CoreValidateExecutionAbortedError';

  public constructor() {
    super('Validate execution was canceled');
  }
}

type RuleValueType = NonNullable<CoreValidateRule['type']>;

function valueType(value: JsonValue): RuleValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'boolean';
}

function sameScalar(left: unknown, right: unknown): boolean {
  return typeof left === typeof right && left === right;
}

const issueMessageKeys: Readonly<
  Record<CoreValidateIssue['code'], keyof typeof CORE_VALIDATE_ISSUE_MESSAGES>
> = Object.freeze({
  required: 'required',
  type: 'type',
  enum: 'enum',
  minimum: 'minimum',
  maximum: 'maximum',
  min_length: 'minLength',
  max_length: 'maxLength',
  min_items: 'minItems',
  max_items: 'maxItems',
});

function issue(
  rule: CoreValidateRule,
  code: CoreValidateIssue['code'],
): CoreValidateIssue {
  const messageKey = issueMessageKeys[code];
  return {
    ruleId: rule.id,
    path: rule.path,
    code,
    message: CORE_VALIDATE_ISSUE_MESSAGES[messageKey],
  };
}

function evaluateRule(
  rule: CoreValidateRule,
  input: CoreValidateInput,
): CoreValidateIssue | undefined {
  const resolution = resolveJsonPath(input, rule.path);
  if (resolution.kind === 'error')
    throw new TypeError('Validate rule path could not be resolved');
  if (resolution.kind === 'missing')
    return rule.required
      ? issue(rule, CORE_VALIDATE_ISSUE_CODES.required)
      : undefined;

  const value = resolution.value;
  if (rule.type !== undefined && valueType(value) !== rule.type)
    return issue(rule, CORE_VALIDATE_ISSUE_CODES.type);
  if (
    rule.enum !== undefined &&
    !rule.enum.some((candidate) => sameScalar(value, candidate))
  )
    return issue(rule, CORE_VALIDATE_ISSUE_CODES.enum);
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum)
      return issue(rule, CORE_VALIDATE_ISSUE_CODES.minimum);
    if (rule.maximum !== undefined && value > rule.maximum)
      return issue(rule, CORE_VALIDATE_ISSUE_CODES.maximum);
  }
  if (typeof value === 'string') {
    let length = 0;
    for (let offset = 0; offset < value.length;) {
      const codePoint = value.codePointAt(offset);
      offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
      length += 1;
      if (
        (rule.maxLength !== undefined && length > rule.maxLength) ||
        (rule.maxLength === undefined &&
          rule.minLength !== undefined &&
          length >= rule.minLength)
      )
        break;
    }
    if (rule.minLength !== undefined && length < rule.minLength)
      return issue(rule, CORE_VALIDATE_ISSUE_CODES.minLength);
    if (rule.maxLength !== undefined && length > rule.maxLength)
      return issue(rule, CORE_VALIDATE_ISSUE_CODES.maxLength);
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems)
      return issue(rule, CORE_VALIDATE_ISSUE_CODES.minItems);
    if (rule.maxItems !== undefined && value.length > rule.maxItems)
      return issue(rule, CORE_VALIDATE_ISSUE_CODES.maxItems);
  }
  return undefined;
}

/** Evaluate the pure Validate contract shared by preview and server callers. */
export function evaluateCoreValidate(
  config: CoreValidateConfig,
  input: CoreValidateInput,
  signal?: AbortSignal,
): CoreValidateOutput {
  const issues: CoreValidateIssue[] = [];
  for (const [index, rule] of config.rules.entries()) {
    if (signal?.aborted) throw new CoreValidateExecutionAbortedError();
    const result = evaluateRule(rule, input);
    if (result !== undefined) issues.push(result);
    if (issues.length === CORE_VALIDATE_MAX_ISSUES) {
      const truncated = index < config.rules.length - 1;
      return {
        valid: false,
        issues,
        truncated,
      };
    }
  }
  if (signal?.aborted) throw new CoreValidateExecutionAbortedError();
  return {
    valid: issues.length === 0,
    issues,
    truncated: false,
  };
}

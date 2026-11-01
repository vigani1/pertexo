import type { ValueSource } from '@pertexo/workflow-model';
import {
  REFERENCE_PATTERN,
  sourceReference,
} from '../input-mappings/reference';
import { EXPRESSION_BYTES_LIMIT } from '../object-mappings/expressions';

/*
 * A Condition step's rules are its existing stored format: one JSONata
 * expression in its `condition` input. Writing rules gives an expression;
 * reading one gives rules only when writing them back is byte-identical, so
 * anything a person wrote stays theirs.
 */

export type ConditionCombinator = 'and' | 'or';

export type ConditionRule = Readonly<{
  id: string;
  /** The reference it reads; empty until a field is chosen. */
  field: string;
  operator: ConditionOperator;
  /** As typed. Kept while an operator that takes no value is chosen. */
  value: string;
}>;

export type ConditionDraft = Readonly<{
  combinator: ConditionCombinator;
  rules: readonly ConditionRule[];
}>;

type OperatorSpec = Readonly<{
  label: string;
  takes: 'text' | 'number' | 'nothing';
  /** Always a true or false, whatever the field holds or if it's missing. */
  write: (field: string, value: string) => string;
}>;

const asText = (field: string) => `$lowercase($string(${field}))`;
const lower = (value: string) => `$lowercase(${value})`;
/** Null, a list and an object aren't text, so they never match one, as in n8n. */
const readsAsText = (field: string) =>
  `$type(${field}) in ["string", "number", "boolean"]`;
const equals = (field: string, value: string) =>
  `${readsAsText(field)} and ${asText(field)} = ${lower(value)}`;
const contains = (field: string, value: string) =>
  `${readsAsText(field)} and $substringBefore(${asText(field)}, ${lower(value)}) != ${asText(field)}`;
const isEmpty = (field: string) =>
  `$not($exists(${field})) or ${field} = null or ${field} = "" or ${field} = {} or ${field} = []`;
const compares = (symbol: string) => (field: string, value: string) =>
  `$type(${field}) = "number" and ${field} ${symbol} ${value}`;

// Text matching ignores case and reads numbers and yes/no values as text, as
// n8n, Zapier and Make do by default. The expression policy allows no
// `$contains`, so a miss is read off `$substringBefore`, which returns the
// whole text when the value isn't in it.
const OPERATORS = {
  equals: { label: 'is equal to', takes: 'text', write: equals },
  not_equals: {
    label: 'is not equal to',
    takes: 'text',
    write: (field, value) => `$not(${equals(field, value)})`,
  },
  contains: { label: 'contains', takes: 'text', write: contains },
  not_contains: {
    label: 'doesn’t contain',
    takes: 'text',
    write: (field, value) => `$not(${contains(field, value)})`,
  },
  starts_with: {
    label: 'starts with',
    takes: 'text',
    write: (field, value) =>
      `${readsAsText(field)} and $substring(${asText(field)}, 0, $length(${lower(value)})) = ${lower(value)}`,
  },
  ends_with: {
    label: 'ends with',
    takes: 'text',
    write: (field, value) =>
      `${readsAsText(field)} and $substring(${asText(field)}, -$length(${lower(value)})) = ${lower(value)}`,
  },
  greater: {
    label: 'is greater than',
    takes: 'number',
    write: compares('>'),
  },
  at_least: { label: 'is at least', takes: 'number', write: compares('>=') },
  less: { label: 'is less than', takes: 'number', write: compares('<') },
  at_most: { label: 'is at most', takes: 'number', write: compares('<=') },
  is_true: {
    label: 'is true',
    takes: 'nothing',
    write: (field) => `${field} = true`,
  },
  is_false: {
    label: 'is false',
    takes: 'nothing',
    write: (field) => `${field} = false`,
  },
  exists: {
    label: 'exists',
    takes: 'nothing',
    write: (field) => `$exists(${field})`,
  },
  not_exists: {
    label: 'doesn’t exist',
    takes: 'nothing',
    write: (field) => `$not($exists(${field}))`,
  },
  is_empty: { label: 'is empty', takes: 'nothing', write: isEmpty },
  not_empty: {
    label: 'isn’t empty',
    takes: 'nothing',
    write: (field) => `$not(${isEmpty(field)})`,
  },
} as const satisfies Readonly<Record<string, OperatorSpec>>;

export type ConditionOperator = keyof typeof OPERATORS;

const OPERATOR_IDS = Object.keys(OPERATORS) as readonly ConditionOperator[];

export const CONDITION_OPERATOR_CHOICES = OPERATOR_IDS.map((value) => ({
  value,
  label: OPERATORS[value].label,
}));

export function isConditionOperator(
  value: string | null,
): value is ConditionOperator {
  return value !== null && Object.hasOwn(OPERATORS, value);
}

export function operatorTakes(operator: ConditionOperator) {
  return OPERATORS[operator].takes;
}

/** Where a field of this type usually starts. */
export function operatorForType(type: string | undefined): ConditionOperator {
  if (type === 'number' || type === 'integer') return 'greater';
  return type === 'boolean' ? 'is_true' : 'equals';
}

export function blankConditionRule(id: string): ConditionRule {
  return { id, field: '', operator: 'equals', value: '' };
}

/** Nothing chosen or typed: the step simply has no condition yet. */
export function isBlankCondition(draft: ConditionDraft): boolean {
  return (
    draft.rules.length === 1 &&
    draft.rules[0]?.field === '' &&
    draft.rules[0].value === ''
  );
}

export type ConditionRuleProblems = Readonly<{
  field?: string;
  value?: string;
}>;

export type ConditionWriting =
  | Readonly<{ kind: 'written'; expression: string }>
  | Readonly<{
      kind: 'unfinished';
      problems: Readonly<Record<string, ConditionRuleProblems>>;
    }>
  | Readonly<{ kind: 'too_long' }>;

export function writeCondition(draft: ConditionDraft): ConditionWriting {
  const problems: Record<string, ConditionRuleProblems> = {};
  const written: string[] = [];
  for (const rule of draft.rules) {
    const literal = literalOf(rule);
    const ruleProblems = {
      ...(rule.field === '' ? { field: 'Choose a field.' } : {}),
      ...(literal.problem === undefined ? {} : { value: literal.problem }),
    };
    if (Object.keys(ruleProblems).length > 0) problems[rule.id] = ruleProblems;
    else written.push(OPERATORS[rule.operator].write(rule.field, literal.text));
  }
  if (Object.keys(problems).length > 0) return { kind: 'unfinished', problems };
  const expression =
    written.length === 1
      ? (written[0] ?? '')
      : written.map((rule) => `(${rule})`).join(` ${draft.combinator} `);
  return new TextEncoder().encode(expression).length > EXPRESSION_BYTES_LIMIT
    ? { kind: 'too_long' }
    : { kind: 'written', expression };
}

function literalOf(
  rule: ConditionRule,
): Readonly<{ text: string; problem?: string }> {
  const takes = OPERATORS[rule.operator].takes;
  if (takes === 'nothing') return { text: '' };
  if (takes === 'text')
    return rule.value === ''
      ? { text: '', problem: 'Enter a value.' }
      : { text: JSON.stringify(rule.value) };
  const number = Number(rule.value.trim());
  return rule.value.trim() === '' || !Number.isFinite(number)
    ? { text: '', problem: 'Enter a number.' }
    : { text: JSON.stringify(number) };
}

export type ConditionReading =
  | Readonly<{ kind: 'rules'; draft: ConditionDraft }>
  | Readonly<{ kind: 'expression'; expression: string }>
  /** A fixed value or a failure field, which only Inputs can show. */
  | Readonly<{ kind: 'other' }>;

/** How a stored `condition` input opens. Reading never changes what's stored. */
export function readCondition(
  source: ValueSource | undefined,
): ConditionReading {
  if (source === undefined)
    return {
      kind: 'rules',
      draft: { combinator: 'and', rules: [blankConditionRule('rule-0')] },
    };
  if (source.kind === 'expression') {
    const draft = rulesFromExpression(source.expression);
    return draft === undefined
      ? { kind: 'expression', expression: source.expression }
      : { kind: 'rules', draft };
  }
  if (source.kind === 'literal') return { kind: 'other' };
  const field = sourceReference(source);
  if (field === undefined) return { kind: 'other' };
  // A field that already holds true or false, as templates point at one.
  return {
    kind: 'rules',
    draft: {
      combinator: 'and',
      rules: [{ id: 'rule-0', field, operator: 'is_true', value: '' }],
    },
  };
}

const MARK_FIELD = '';
const MARK_VALUE = '';
const TEXT_LITERAL = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const NUMBER_LITERAL = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;

/** Each operator's exact shape, from the one place that writes it. */
const RULE_SHAPES = OPERATOR_IDS.map((operator) => {
  const spec: OperatorSpec = OPERATORS[operator];
  const literal = spec.takes === 'text' ? TEXT_LITERAL : NUMBER_LITERAL;
  let firstField = true;
  let firstValue = true;
  const pattern = spec
    .write(MARK_FIELD, MARK_VALUE)
    .replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll(MARK_FIELD, () => {
      if (!firstField) return String.raw`\k<field>`;
      firstField = false;
      return `(?<field>${REFERENCE_PATTERN})`;
    })
    .replaceAll(MARK_VALUE, () => {
      if (!firstValue) return String.raw`\k<value>`;
      firstValue = false;
      return `(?<value>${literal})`;
    });
  return { operator, shape: new RegExp(`^${pattern}$`, 'u') };
});

function ruleFromText(text: string, id: string): ConditionRule | undefined {
  for (const { operator, shape } of RULE_SHAPES) {
    const groups = shape.exec(text)?.groups;
    if (groups?.field === undefined) continue;
    const parsed: unknown =
      groups.value === undefined ? '' : JSON.parse(groups.value);
    return { id, field: groups.field, operator, value: String(parsed) };
  }
  return undefined;
}

function rulesFromExpression(expression: string): ConditionDraft | undefined {
  const single = ruleFromText(expression, 'rule-0');
  const draft: ConditionDraft | undefined =
    single === undefined
      ? joinedRules(expression)
      : { combinator: 'and', rules: [single] };
  if (draft === undefined) return undefined;
  const written = writeCondition(draft);
  return written.kind === 'written' && written.expression === expression
    ? draft
    : undefined;
}

/** `(rule) and (rule)`, cut only where no string or bracket is open. */
function joinedRules(expression: string): ConditionDraft | undefined {
  const parts: string[] = [];
  const joins = new Set<ConditionCombinator>();
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '(' || char === '{') depth += 1;
    else if (char === ')' || char === '}') depth -= 1;
    else if (depth === 0) {
      const join = ([' and ', ' or '] as const).find((word) =>
        expression.startsWith(word, index),
      );
      if (join === undefined) continue;
      joins.add(join.trim() as ConditionCombinator);
      parts.push(expression.slice(start, index));
      index += join.length - 1;
      start = index + 1;
    }
  }
  parts.push(expression.slice(start));
  const [combinator] = joins;
  if (combinator === undefined || joins.size > 1) return undefined;
  const rules = parts.map((part, index) =>
    part.startsWith('(') && part.endsWith(')')
      ? ruleFromText(part.slice(1, -1), `rule-${String(index)}`)
      : undefined,
  );
  return rules.every((rule) => rule !== undefined)
    ? { combinator, rules }
    : undefined;
}

import { parseJsonPath } from '@pertexo/workflow-model/json-path';
import type { FieldParseResult, NodeConfig } from './inspector-draft';

// Setup for the steps whose settings are lists (Switch cases, Parallel
// branches, Validate rules), read from and written back to the step's
// config. Each reader returns undefined for a config it can't model, so the
// step stays on "Edit as JSON" rather than losing anything.

type ConfigValue = NodeConfig[string];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numbered(prefix: string, count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`,
  );
}

/** The lowest ID in `ids` that `used` doesn't hold yet. */
function nextFree(
  ids: readonly string[],
  used: readonly string[],
): string | undefined {
  const taken = new Set(used);
  return ids.find((id) => !taken.has(id));
}

/** `list` with the entry at `index` moved by one place. */
export function moved<Entry>(
  list: readonly Entry[],
  index: number,
  by: -1 | 1,
): readonly Entry[] {
  const target = index + by;
  const entry = list[index];
  const other = list[target];
  if (entry === undefined || other === undefined) return list;
  const next = [...list];
  next[index] = other;
  next[target] = entry;
  return next;
}

// ---------------------------------------------------------------- Switch

/** Switch's fixed case ports (ADR 018). */
export const SWITCH_CASE_IDS = numbered('case', 16);

export type SwitchScalar = null | boolean | number | string;
export type SwitchCase = Readonly<{ id: string; equals: SwitchScalar }>;

function isScalar(value: unknown): value is SwitchScalar {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** The cases in stored order, or undefined for a config this can't model. */
export function readSwitchCases(
  config: NodeConfig,
): readonly SwitchCase[] | undefined {
  const cases = config.cases;
  if (cases === undefined) return [];
  if (!Array.isArray(cases)) return undefined;
  const read: SwitchCase[] = [];
  for (const entry of cases) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2) return undefined;
    const { id, equals } = entry;
    if (typeof id !== 'string' || !SWITCH_CASE_IDS.includes(id))
      return undefined;
    if (!isScalar(equals)) return undefined;
    read.push({ id, equals });
  }
  return read;
}

export function withSwitchCases(
  config: NodeConfig,
  cases: readonly SwitchCase[],
): NodeConfig {
  return {
    ...config,
    cases: cases.map((entry) => ({ id: entry.id, equals: entry.equals })),
  };
}

/** A new case on the lowest free port, matching an empty text until set. */
export function addSwitchCase(
  cases: readonly SwitchCase[],
): readonly SwitchCase[] {
  const id = nextFree(
    SWITCH_CASE_IDS,
    cases.map((entry) => entry.id),
  );
  return id === undefined ? cases : [...cases, { id, equals: '' }];
}

export type ScalarKind = 'text' | 'number' | 'boolean' | 'null';

export function scalarKind(value: SwitchScalar): ScalarKind {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'text';
}

/** The value a case takes when its kind changes. */
export function scalarOfKind(kind: ScalarKind): SwitchScalar {
  switch (kind) {
    case 'text':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
  }
}

/** Text typed for a number case. */
export function parseSwitchNumber(text: string): FieldParseResult<number> {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value)
    ? { ok: false, error: 'Enter a number, like 3 or 2.5.' }
    : { ok: true, value };
}

export const SWITCH_TEXT_MAX = 1_024;

// -------------------------------------------------------------- Parallel

/** Parallel's fixed branch ports (ADR 019). */
export const PARALLEL_BRANCH_IDS = numbered('branch', 16);
export const PARALLEL_MIN_BRANCHES = 2;

/** The configured branch IDs, or undefined for a config this can't model. */
export function readParallelBranches(
  config: NodeConfig,
): readonly string[] | undefined {
  const branches = config.branches;
  if (branches === undefined) return [];
  if (!Array.isArray(branches)) return undefined;
  const ids: string[] = [];
  for (const entry of branches) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) return undefined;
    const { id } = entry;
    if (typeof id !== 'string' || !PARALLEL_BRANCH_IDS.includes(id))
      return undefined;
    ids.push(id);
  }
  return ids;
}

/**
 * The config with `count` branches: existing ones kept, new ones on the
 * lowest free ports, and removal from the highest. "Branches at once" never
 * exceeds the branches there are.
 */
export function withParallelBranchCount(
  config: NodeConfig,
  branches: readonly string[],
  count: number,
): NodeConfig {
  let next = [...branches];
  while (next.length < count) {
    const id = nextFree(PARALLEL_BRANCH_IDS, next);
    if (id === undefined) break;
    next.push(id);
  }
  while (next.length > count) {
    const last = lastParallelBranch(next);
    next = next.filter((id) => id !== last);
  }
  // Unset, it starts as every branch at once.
  const atOnce = config.maxConcurrency;
  return {
    ...config,
    branches: next.map((id) => ({ id })),
    maxConcurrency:
      typeof atOnce === 'number' ? Math.min(atOnce, next.length) : next.length,
  };
}

/** The branch that removing one would drop: the highest-numbered. */
export function lastParallelBranch(
  branches: readonly string[],
): string | undefined {
  return [...branches].sort((a, b) => a.localeCompare(b)).at(-1);
}

// -------------------------------------------------------------- Validate

export const VALIDATE_TYPES = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
] as const;
export type ValidateType = (typeof VALIDATE_TYPES)[number];
export const VALIDATE_MAX_RULES = 64;

/** The bounds each type allows (ADR 032); other types allow none. */
export const VALIDATE_BOUNDS: Readonly<
  Partial<Record<ValidateType, readonly [string, string]>>
> = {
  string: ['minLength', 'maxLength'],
  number: ['minimum', 'maximum'],
  array: ['minItems', 'maxItems'],
};

const RULE_KEYS = new Set([
  'id',
  'path',
  'required',
  'type',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

export type ValidateRule = Readonly<Record<string, ConfigValue>> &
  Readonly<{ id: string; path: string; required: boolean }>;

/** The rules in stored order, or undefined for a config this can't model. */
export function readValidateRules(
  config: NodeConfig,
): readonly ValidateRule[] | undefined {
  const rules = config.rules;
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return undefined;
  const read: ValidateRule[] = [];
  for (const entry of rules) {
    if (!isRecord(entry)) return undefined;
    if (Object.keys(entry).some((key) => !RULE_KEYS.has(key))) return undefined;
    const { id, path, required } = entry;
    if (typeof id !== 'string' || typeof path !== 'string') return undefined;
    if (required !== undefined && typeof required !== 'boolean')
      return undefined;
    read.push({
      ...(entry as Readonly<Record<string, ConfigValue>>),
      id,
      path,
      required: required ?? false,
    });
  }
  return read;
}

export function withValidateRules(
  config: NodeConfig,
  rules: readonly ValidateRule[],
): NodeConfig {
  return { ...config, rules: rules.map((rule) => ({ ...rule })) };
}

/** A new rule with a unique ID, checking that a path is there. */
export function addValidateRule(
  rules: readonly ValidateRule[],
): readonly ValidateRule[] {
  if (rules.length >= VALIDATE_MAX_RULES) return rules;
  const ids = new Set(rules.map((rule) => rule.id));
  let number = rules.length + 1;
  while (ids.has(`rule-${String(number)}`)) number += 1;
  return [
    ...rules,
    { id: `rule-${String(number)}`, path: '$.', required: true },
  ];
}

/** One rule with a new type, dropping bounds and values the type can't have. */
export function withRuleType(
  rule: ValidateRule,
  type: ValidateType | undefined,
): ValidateRule {
  const kept = Object.fromEntries(
    Object.entries(rule).filter(
      ([key]) =>
        key === 'id' ||
        key === 'path' ||
        key === 'required' ||
        (type !== undefined && (VALIDATE_BOUNDS[type]?.includes(key) ?? false)),
    ),
  );
  return {
    ...(kept as ValidateRule),
    ...(type === undefined ? {} : { type }),
  };
}

/** Why a path can't be used, or undefined when it can. */
export function validatePathProblem(path: string): string | undefined {
  if (path.trim() === '') return 'Enter the path to check, like $.email.';
  if (parseJsonPath(path) === undefined)
    return 'Write the path like $.email or $.items[0].id.';
  return undefined;
}

/**
 * "One of" values typed as a comma-separated list: numbers for a number
 * rule, text otherwise. Empty text removes the list.
 */
export function parseRuleEnum(
  text: string,
  type: ValidateType | undefined,
): FieldParseResult<readonly (string | number)[] | undefined> {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return { ok: true, value: undefined };
  if (new Set(parts).size !== parts.length)
    return { ok: false, error: 'List each value once.' };
  if (parts.length > 32) return { ok: false, error: 'List at most 32 values.' };
  if (type !== 'number') return { ok: true, value: parts };
  const numbers = parts.map(Number);
  return numbers.every(Number.isFinite)
    ? { ok: true, value: numbers }
    : { ok: false, error: 'List numbers, like 1, 2, 3.' };
}

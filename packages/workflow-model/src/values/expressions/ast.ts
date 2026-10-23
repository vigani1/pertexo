import { isRecord } from '../json/object.js';

const BUILTINS = new Set([
  'string',
  'number',
  'boolean',
  'not',
  'exists',
  'type',
  'count',
  'sum',
  'min',
  'max',
  'average',
  'append',
  'reverse',
  'distinct',
  'join',
  'substring',
  'substringBefore',
  'substringAfter',
  'uppercase',
  'lowercase',
  'length',
  'trim',
  'pad',
  'keys',
  'lookup',
  'merge',
  'spread',
]);

const DISALLOWED_TYPES = new Set([
  'bind',
  'lambda',
  'partial',
  'transform',
  'regex',
  'regexp',
  'descendant',
  'apply',
]);

const ALLOWED_TYPES = new Set([
  'binary',
  'unary',
  'function',
  'condition',
  'block',
  'name',
  'parent',
  'string',
  'number',
  'value',
  'wildcard',
  'variable',
  'operator',
  'path',
  'filter',
]);

const FORBIDDEN_ROOT_NAMES = new Set([
  'process',
  'require',
  'constructor',
  'prototype',
  '__proto__',
  'global',
  'globalThis',
  'module',
]);

type JsonataAst = Readonly<Record<string, unknown>>;

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export /**
 * JSONata's public AST type is permissive and has changed shape between
 * releases. Keep the dependency conversion here, validate what the policy
 * walker consumes, and let the caller classify malformed dependency output as
 * an invalid expression.
 */
function readJsonataAst(value: unknown): JsonataAst {
  if (!isRecord(value))
    throw new TypeError('JSONata returned a non-object AST');
  if (value.type !== undefined && typeof value.type !== 'string')
    throw new TypeError('JSONata returned an invalid AST node type');
  if (value.procedure !== undefined && !isRecord(value.procedure))
    throw new TypeError('JSONata returned an invalid AST procedure');
  if (
    value.steps !== undefined &&
    (!Array.isArray(value.steps) || value.steps.some((step) => !isRecord(step)))
  )
    throw new TypeError('JSONata returned invalid AST path steps');
  return value;
}

export function astSize(root: JsonataAst): {
  nodes: number;
  depth: number;
  disallowed?: string;
} {
  let nodes = 0;
  let depth = 0;
  let disallowed: string | undefined;
  const visit = (value: unknown, level: number, parentKey?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, level, parentKey);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (!isRecord(value)) return;
    const type = value.type;
    if (typeof type === 'string') {
      nodes += 1;
      depth = Math.max(depth, level);
      disallowed = classifyAstNode(value, type, parentKey, disallowed);
    }
    for (const [key, child] of Object.entries(value))
      if (!['value', 'position', 'type'].includes(key))
        visit(child, level + 1, key);
  };
  visit(root, 1);
  return disallowed === undefined
    ? { nodes, depth }
    : { nodes, depth, disallowed };
}

function classifyAstNode(
  value: Record<string, unknown>,
  type: string,
  parentKey: string | undefined,
  prior: string | undefined,
): string | undefined {
  let disallowed = prior;
  if (DISALLOWED_TYPES.has(type) || !ALLOWED_TYPES.has(type)) disallowed = type;
  if (type === 'function' && isDisallowedCall(value)) disallowed = 'callable';
  if (hasPathMetadata(value, type)) disallowed = 'path_metadata';
  if (isDisallowedVariable(value, type, parentKey)) disallowed = 'variable';
  if (isHostIdentifier(value, type)) disallowed = 'host_identifier';
  return disallowed;
}

function isDisallowedCall(value: Record<string, unknown>): boolean {
  const procedure = isRecord(value.procedure) ? value.procedure : undefined;
  return (
    procedure?.type !== 'variable' ||
    typeof procedure.value !== 'string' ||
    !BUILTINS.has(procedure.value)
  );
}

function hasPathMetadata(
  value: Record<string, unknown>,
  type: string,
): boolean {
  return (
    (type === 'path' || type === 'name') &&
    (Object.hasOwn(value, 'group') ||
      Object.hasOwn(value, 'focus') ||
      Object.hasOwn(value, 'index') ||
      Object.hasOwn(value, 'tuple'))
  );
}

function isDisallowedVariable(
  value: Record<string, unknown>,
  type: string,
  parentKey: string | undefined,
): boolean {
  return (
    type === 'variable' &&
    parentKey !== 'procedure' &&
    value.value !== '' &&
    value.value !== 'vars' &&
    value.value !== 'execution'
  );
}

function isHostIdentifier(
  value: Record<string, unknown>,
  type: string,
): boolean {
  const steps = isUnknownArray(value.steps) ? value.steps : undefined;
  const firstStep = steps?.[0];
  return (
    type === 'path' &&
    isRecord(firstStep) &&
    firstStep.type === 'name' &&
    FORBIDDEN_ROOT_NAMES.has(String(firstStep.value))
  );
}

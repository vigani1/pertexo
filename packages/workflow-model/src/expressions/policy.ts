import { availableParallelism } from 'node:os';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import jsonata from 'jsonata';
import { canonicalizeJson, type JsonValue } from '../canonical-json.js';

export const EXPRESSION_POLICY_V1 = Object.freeze({
  policyVersion: 1 as const,
  expressionBytes: 16_384,
  astDepth: 64,
  astNodes: 2_048,
  inputBytes: 1_048_576,
  inputDepth: 64,
  inputMembers: 10_000,
  timeoutMs: 100,
  startupTimeoutMs: 5_000,
  maxActive: Math.min(4, availableParallelism()),
  maxQueued: 128,
  outputBytes: 1_048_576,
  outputDepth: 64,
  outputMembers: 10_000,
});

export type ExpressionLimit =
  | 'expression_bytes'
  | 'ast_depth'
  | 'ast_nodes'
  | 'input_bytes'
  | 'input_depth'
  | 'input_members'
  | 'output_bytes'
  | 'output_depth'
  | 'output_members'
  | 'pool_capacity';

export type ExpressionResult =
  | {
      readonly kind: 'value';
      readonly value: JsonValue;
      readonly canonicalBytes: number;
    }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'error';
      readonly code:
        | 'invalid_expression'
        | 'disallowed_construct'
        | 'limit_exceeded'
        | 'timed_out'
        | 'canceled'
        | 'evaluation_failed';
      readonly message: string;
      readonly limit?: ExpressionLimit;
    };

export interface ExpressionContextV1 {
  readonly runInput: JsonValue;
  readonly nodeOutputs: Readonly<Record<string, JsonValue>>;
}

export interface ExpressionRequest {
  readonly expression: string;
  readonly policyVersion: number;
  readonly context: ExpressionContextV1;
  readonly signal?: AbortSignal;
}

export type ExpressionValidation =
  { readonly kind: 'valid' } | Extract<ExpressionResult, { kind: 'error' }>;

export interface ExpressionEvaluator {
  evaluate(request: ExpressionRequest): Promise<ExpressionResult>;
}

export type ExpressionWorkerFactory = (
  runtimeUrl: URL,
  options: WorkerOptions,
) => Worker;

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

function isRecord(value: unknown): value is JsonataAst {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
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

export function expressionError(
  code: Extract<ExpressionResult, { kind: 'error' }>['code'],
  message: string,
  limit?: ExpressionLimit,
): Extract<ExpressionResult, { kind: 'error' }> {
  return limit === undefined
    ? { kind: 'error', code, message }
    : { kind: 'error', code, message, limit };
}

function astSize(root: JsonataAst): {
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
      if (DISALLOWED_TYPES.has(type) || !ALLOWED_TYPES.has(type))
        disallowed = type;
      if (type === 'function') {
        const procedure = isRecord(value.procedure)
          ? value.procedure
          : undefined;
        if (
          procedure?.type !== 'variable' ||
          typeof procedure.value !== 'string' ||
          !BUILTINS.has(procedure.value)
        )
          disallowed = 'callable';
      }
      if (
        (type === 'path' || type === 'name') &&
        (Object.hasOwn(value, 'group') ||
          Object.hasOwn(value, 'focus') ||
          Object.hasOwn(value, 'index') ||
          Object.hasOwn(value, 'tuple'))
      )
        disallowed = 'path_metadata';
      if (
        type === 'variable' &&
        parentKey !== 'procedure' &&
        value.value !== ''
      )
        disallowed = 'variable';
      const steps = isUnknownArray(value.steps) ? value.steps : undefined;
      const firstStep = steps?.[0];
      if (
        type === 'path' &&
        isRecord(firstStep) &&
        firstStep.type === 'name' &&
        FORBIDDEN_ROOT_NAMES.has(String(firstStep.value))
      )
        disallowed = 'host_identifier';
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

export function validateExpression(
  source: string,
  policyVersion: number,
): ExpressionValidation {
  if (policyVersion !== 1)
    return expressionError(
      'invalid_expression',
      `unsupported expression policy ${String(policyVersion)}`,
    );
  if (Buffer.byteLength(source, 'utf8') > EXPRESSION_POLICY_V1.expressionBytes)
    return expressionError(
      'limit_exceeded',
      'expression bytes exceed policy',
      'expression_bytes',
    );
  try {
    const ast = readJsonataAst(jsonata(source).ast());
    const size = astSize(ast);
    if (size.depth > EXPRESSION_POLICY_V1.astDepth)
      return expressionError(
        'limit_exceeded',
        'AST depth exceeds policy',
        'ast_depth',
      );
    if (size.nodes > EXPRESSION_POLICY_V1.astNodes)
      return expressionError(
        'limit_exceeded',
        'AST node count exceeds policy',
        'ast_nodes',
      );
    if (size.disallowed)
      return expressionError(
        'disallowed_construct',
        `JSONata construct ${size.disallowed} is unavailable`,
      );
    return { kind: 'valid' };
  } catch (cause) {
    return expressionError(
      'invalid_expression',
      cause instanceof Error ? cause.message : 'expression could not be parsed',
    );
  }
}

export const JSONATA_EVALUATOR_DIAGNOSTICS = Object.freeze({
  library: 'jsonata',
  libraryVersion: '2.2.2',
  policyVersion: 1 as const,
  isolation: 'bounded_one_shot_worker' as const,
});

/**
 * Canonicalizes only the two values exposed to JSONata. The evaluator calls
 * this before queue admission so hostile context values cannot reach a worker.
 */
export function projectExpressionContext(value: unknown): ExpressionContextV1 {
  if (value === null || typeof value !== 'object')
    throw new TypeError('expression context must be an object');
  const context = value as Record<string, unknown>;
  if (
    !Object.hasOwn(context, 'runInput') ||
    !Object.hasOwn(context, 'nodeOutputs')
  )
    throw new TypeError('expression context requires runInput and nodeOutputs');
  const canonical = canonicalizeJson({
    runInput: context.runInput,
    nodeOutputs: context.nodeOutputs,
  });
  if (!isJsonObject(canonical))
    throw new TypeError('expression context must be an object');
  if (
    !Object.hasOwn(canonical, 'runInput') ||
    !Object.hasOwn(canonical, 'nodeOutputs')
  )
    throw new TypeError('expression context requires runInput and nodeOutputs');
  const runInput = canonical.runInput;
  const nodeOutputs = canonical.nodeOutputs;
  if (
    runInput === undefined ||
    nodeOutputs === undefined ||
    !isJsonObject(nodeOutputs)
  )
    throw new TypeError(
      'expression context requires JSON runInput and nodeOutputs',
    );
  return {
    runInput,
    nodeOutputs,
  };
}

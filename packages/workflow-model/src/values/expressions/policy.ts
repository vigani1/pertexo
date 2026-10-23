import { readJsonataAst, astSize } from './ast.js';
import { utf8ByteLength } from '../text.js';
import {
  callbackReferences,
  type CallbackReference,
} from '../../flow/callbacks/references.js';
import type { CallbackBindings } from '../../flow/callbacks/contract.js';
import {
  expressionVariableReferences,
  type ExpressionVariableReferences,
} from './variable-references.js';
import {
  workspaceVariableValuesSchema,
  type WorkspaceVariableValues,
} from '../variables/contract.js';

import { availableParallelism } from 'node:os';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import jsonata from 'jsonata';
import { normalizeJson, type JsonValue } from '../json/canonical.js';

export const EXPRESSION_POLICY = Object.freeze({
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
        | 'evaluation_failed'
        | 'variable_missing'
        | 'callback_unavailable';
      readonly message: string;
      readonly limit?: ExpressionLimit;
    };

export interface ExpressionContext {
  readonly execution?: Readonly<{ callbacks: CallbackBindings }>;
  readonly variables?: WorkspaceVariableValues;
  readonly runInput: JsonValue;
  readonly nodeOutputs: Readonly<Record<string, JsonValue>>;
  /** Inside a For each body, the nearest iteration's `item` and `ordinal`. */
  readonly loop?: Readonly<Record<string, JsonValue>>;
}

export interface ExpressionRequest {
  readonly expression: string;
  readonly context: ExpressionContext;
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

function isJsonObject(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function inspectExpression(source: string):
  | Exclude<ExpressionValidation, { kind: 'valid' }>
  | Readonly<{
      kind: 'valid';
      references: ExpressionVariableReferences;
      callbacks: readonly CallbackReference[];
    }> {
  if (utf8ByteLength(source) > EXPRESSION_POLICY.expressionBytes)
    return expressionError(
      'limit_exceeded',
      'expression bytes exceed policy',
      'expression_bytes',
    );
  try {
    const ast = readJsonataAst(jsonata(source).ast());
    const size = astSize(ast);
    if (size.depth > EXPRESSION_POLICY.astDepth)
      return expressionError(
        'limit_exceeded',
        'AST depth exceeds policy',
        'ast_depth',
      );
    if (size.nodes > EXPRESSION_POLICY.astNodes)
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
    const callbacks = callbackReferences(ast);
    if (callbacks.invalid)
      return expressionError(
        'disallowed_construct',
        'Select a callback URL or secret by its Wait step identity.',
      );
    return {
      kind: 'valid',
      references: expressionVariableReferences(ast),
      callbacks: callbacks.references,
    };
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
  isolation: 'bounded_one_shot_worker' as const,
});

/**
 * Canonicalizes the data exposed to JSONata, including its immutable variable binding. The evaluator calls
 * this before queue admission so hostile context values cannot reach a worker.
 */
export function projectExpressionContext(
  value: unknown,
  readsVariables = true,
): ExpressionContext {
  try {
    if (value === null || typeof value !== 'object') throw new TypeError();
    const runInputDescriptor = Object.getOwnPropertyDescriptor(
      value,
      'runInput',
    );
    const nodeOutputsDescriptor = Object.getOwnPropertyDescriptor(
      value,
      'nodeOutputs',
    );
    if (
      runInputDescriptor === undefined ||
      !('value' in runInputDescriptor) ||
      nodeOutputsDescriptor === undefined ||
      !('value' in nodeOutputsDescriptor)
    )
      throw new TypeError();
    const runInputValue: unknown = runInputDescriptor.value;
    const nodeOutputsValue: unknown = nodeOutputsDescriptor.value;
    const variablesDescriptor = readsVariables
      ? Object.getOwnPropertyDescriptor(value, 'variables')
      : undefined;
    if (variablesDescriptor !== undefined && !('value' in variablesDescriptor))
      throw new TypeError();
    const variablesValue: unknown = variablesDescriptor?.value;
    const loopDescriptor = Object.getOwnPropertyDescriptor(value, 'loop');
    if (loopDescriptor !== undefined && !('value' in loopDescriptor))
      throw new TypeError();
    const loopValue: unknown = loopDescriptor?.value;
    const executionDescriptor = Object.getOwnPropertyDescriptor(
      value,
      'execution',
    );
    if (executionDescriptor !== undefined && !('value' in executionDescriptor))
      throw new TypeError();
    const executionValue: unknown = executionDescriptor?.value;
    const canonical = normalizeJson({
      ...(executionValue === undefined ? {} : { execution: executionValue }),
      runInput: runInputValue,
      nodeOutputs: nodeOutputsValue,
      ...(variablesValue === undefined ? {} : { variables: variablesValue }),
      ...(loopValue === undefined ? {} : { loop: loopValue }),
    });
    if (!isJsonObject(canonical)) throw new TypeError();
    const variables =
      canonical.variables === undefined
        ? undefined
        : workspaceVariableValuesSchema.parse(canonical.variables);
    const runInput = canonical.runInput;
    const nodeOutputs = canonical.nodeOutputs;
    const loop = canonical.loop;
    const execution = canonical.execution;
    let executionBinding: ExpressionContext['execution'];
    if (execution !== undefined) {
      if (!isJsonObject(execution)) throw new TypeError();
      const callbacks = execution.callbacks;
      if (callbacks === undefined || !isJsonObject(callbacks))
        throw new TypeError();
      const bindings = Object.entries(callbacks).map(([id, entry]) => {
        if (
          !isJsonObject(entry) ||
          typeof entry.url !== 'string' ||
          (entry.secret !== undefined && typeof entry.secret !== 'string')
        )
          throw new TypeError();
        return [
          id,
          {
            url: entry.url,
            ...(entry.secret === undefined ? {} : { secret: entry.secret }),
          },
        ] as const;
      });
      executionBinding = { callbacks: Object.fromEntries(bindings) };
    }
    if (
      runInput === undefined ||
      nodeOutputs === undefined ||
      !isJsonObject(nodeOutputs) ||
      (loop !== undefined && !isJsonObject(loop))
    )
      throw new TypeError();
    return {
      runInput,
      nodeOutputs,
      ...(executionBinding === undefined
        ? {}
        : { execution: executionBinding }),
      ...(variables === undefined ? {} : { variables }),
      ...(loop === undefined ? {} : { loop }),
    };
  } catch {
    throw new TypeError('invalid expression context');
  }
}

export function validateExpression(source: string): ExpressionValidation {
  const inspected = inspectExpression(source);
  return inspected.kind === 'valid' ? { kind: 'valid' } : inspected;
}

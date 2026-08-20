import './server-only.js';
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import jsonata from 'jsonata';
import {
  canonicalizeJson,
  inspectJsonValue,
  type JsonValue,
} from './canonical-json.js';

export const EXPRESSION_POLICY_V1 = Object.freeze({
  policyVersion: 1 as const,
  expressionBytes: 16_384,
  astDepth: 64,
  astNodes: 2_048,
  inputBytes: 1_048_576,
  inputDepth: 64,
  inputMembers: 10_000,
  timeoutMs: 100,
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
type Ast = Record<string, unknown> & {
  type?: string;
  value?: unknown;
  procedure?: Ast;
  steps?: Ast[];
};
function error(
  code: Extract<ExpressionResult, { kind: 'error' }>['code'],
  message: string,
  limit?: ExpressionLimit,
): Extract<ExpressionResult, { kind: 'error' }> {
  return limit === undefined
    ? { kind: 'error', code, message }
    : { kind: 'error', code, message, limit };
}
function astSize(root: Ast): {
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
    const node = value as Ast;
    if (typeof node.type === 'string') {
      nodes += 1;
      depth = Math.max(depth, level);
      if (DISALLOWED_TYPES.has(node.type) || !ALLOWED_TYPES.has(node.type))
        disallowed = node.type;
      if (node.type === 'function') {
        const procedure = node.procedure;
        if (
          procedure?.type !== 'variable' ||
          typeof procedure.value !== 'string' ||
          !BUILTINS.has(procedure.value)
        )
          disallowed = 'callable';
      }
      if (
        node.type === 'variable' &&
        parentKey !== 'procedure' &&
        node.value !== ''
      )
        disallowed = 'variable';
      if (
        node.type === 'path' &&
        node.steps?.[0]?.type === 'name' &&
        FORBIDDEN_ROOT_NAMES.has(String(node.steps[0].value))
      )
        disallowed = 'host_identifier';
    }
    for (const [key, child] of Object.entries(node))
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
    return error(
      'invalid_expression',
      `unsupported expression policy ${String(policyVersion)}`,
    );
  if (Buffer.byteLength(source, 'utf8') > EXPRESSION_POLICY_V1.expressionBytes)
    return error(
      'limit_exceeded',
      'expression bytes exceed policy',
      'expression_bytes',
    );
  try {
    const ast = jsonata(source).ast() as unknown as Ast;
    const size = astSize(ast);
    if (size.depth > EXPRESSION_POLICY_V1.astDepth)
      return error('limit_exceeded', 'AST depth exceeds policy', 'ast_depth');
    if (size.nodes > EXPRESSION_POLICY_V1.astNodes)
      return error(
        'limit_exceeded',
        'AST node count exceeds policy',
        'ast_nodes',
      );
    if (size.disallowed)
      return error(
        'disallowed_construct',
        `JSONata construct ${size.disallowed} is unavailable`,
      );
    return { kind: 'valid' };
  } catch (cause) {
    return error(
      'invalid_expression',
      cause instanceof Error ? cause.message : 'expression could not be parsed',
    );
  }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
function nullObjects(value) { if (Array.isArray(value)) return value.map(nullObjects); if (value && typeof value === 'object') { const out=Object.create(null); for (const key of Object.keys(value).sort()) out[key]=nullObjects(value[key]); return out; } return value; }
(async () => {
  try {
    const imported=await import(workerData.moduleUrl); const compile=imported.default || imported;
    parentPort.postMessage({ ready:true });
    parentPort.once('message', async ({ expression, context }) => {
      try { const input=nullObjects(context); parentPort.postMessage({ started:true }); const value=await compile(expression).evaluate(input); parentPort.postMessage({ ok:true, missing:value === undefined, value }); }
      catch (caught) { parentPort.postMessage({ ok:false, message:caught instanceof Error ? caught.message : 'evaluation failed' }); }
    });
  } catch (caught) { parentPort.postMessage({ ok:false, message:caught instanceof Error ? caught.message : 'evaluator startup failed' }); }
})();`;

const require = createRequire(import.meta.url);
const JSONATA_MODULE_URL = pathToFileURL(require.resolve('jsonata')).href;
export const JSONATA_EVALUATOR_DIAGNOSTICS = Object.freeze({
  library: 'jsonata',
  libraryVersion: '2.2.2',
  policyVersion: 1 as const,
});

interface Pending {
  readonly request: ExpressionRequest;
  readonly resolve: (result: ExpressionResult) => void;
  queuedAbort: (() => void) | undefined;
}
export class JsonataEvaluator {
  readonly #maxActive: number;
  readonly #maxQueued: number;
  #active = 0;
  #closed = false;
  readonly #queue: Pending[] = [];
  readonly #workers = new Set<Worker>();
  constructor(
    options: { readonly maxActive?: number; readonly maxQueued?: number } = {},
  ) {
    this.#maxActive = options.maxActive ?? EXPRESSION_POLICY_V1.maxActive;
    this.#maxQueued = options.maxQueued ?? EXPRESSION_POLICY_V1.maxQueued;
    if (
      !Number.isSafeInteger(this.#maxActive) ||
      this.#maxActive < 1 ||
      this.#maxActive > EXPRESSION_POLICY_V1.maxActive ||
      !Number.isSafeInteger(this.#maxQueued) ||
      this.#maxQueued < 0 ||
      this.#maxQueued > EXPRESSION_POLICY_V1.maxQueued
    )
      throw new RangeError('evaluator pool options exceed policy v1 bounds');
  }
  evaluate(request: ExpressionRequest): Promise<ExpressionResult> {
    if (this.#closed)
      return Promise.resolve(error('canceled', 'evaluator is shut down'));
    if (request.signal?.aborted)
      return Promise.resolve(error('canceled', 'evaluation canceled'));
    const validation = validateExpression(
      request.expression,
      request.policyVersion,
    );
    if (validation.kind === 'error') return Promise.resolve(validation);
    let inspection;
    try {
      inspection = inspectJsonValue(request.context);
    } catch (cause) {
      return Promise.resolve(
        error(
          'evaluation_failed',
          cause instanceof Error ? cause.message : 'invalid context',
        ),
      );
    }
    for (const [limit, actual, maximum] of [
      ['input_bytes', inspection.bytes, EXPRESSION_POLICY_V1.inputBytes],
      ['input_depth', inspection.depth, EXPRESSION_POLICY_V1.inputDepth],
      ['input_members', inspection.members, EXPRESSION_POLICY_V1.inputMembers],
    ] as const)
      if (actual > maximum)
        return Promise.resolve(
          error('limit_exceeded', `${limit} exceeds policy`, limit),
        );
    if (
      this.#active >= this.#maxActive &&
      this.#queue.length >= this.#maxQueued
    )
      return Promise.resolve(
        error(
          'limit_exceeded',
          'evaluator pool queue is full',
          'pool_capacity',
        ),
      );
    return new Promise((resolve) => {
      const pending: Pending = {
        request: {
          ...request,
          context: canonicalizeJson(
            request.context,
          ) as unknown as ExpressionContextV1,
        },
        resolve,
        queuedAbort: undefined,
      };
      if (request.signal) {
        pending.queuedAbort = () => {
          const index = this.#queue.indexOf(pending);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            resolve(error('canceled', 'queued evaluation canceled'));
          }
        };
        request.signal.addEventListener('abort', pending.queuedAbort, {
          once: true,
        });
      }
      this.#queue.push(pending);
      this.#drain();
    });
  }
  preview(request: ExpressionRequest): Promise<ExpressionResult> {
    return this.evaluate(request);
  }
  runtime(request: ExpressionRequest): Promise<ExpressionResult> {
    return this.evaluate(request);
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#queue.splice(0)) {
      if (pending.queuedAbort)
        pending.request.signal?.removeEventListener(
          'abort',
          pending.queuedAbort,
        );
      pending.resolve(error('canceled', 'evaluator shut down'));
    }
    await Promise.all(
      [...this.#workers].map(async (worker) => {
        await worker.terminate();
      }),
    );
  }
  #drain(): void {
    while (
      !this.#closed &&
      this.#active < this.#maxActive &&
      this.#queue.length > 0
    ) {
      const pending = this.#queue.shift();
      if (!pending) return;
      if (pending.queuedAbort)
        pending.request.signal?.removeEventListener(
          'abort',
          pending.queuedAbort,
        );
      if (pending.request.signal?.aborted) {
        pending.resolve(error('canceled', 'evaluation canceled'));
        continue;
      }
      this.#active += 1;
      void this.#run(pending).finally(() => {
        this.#active -= 1;
        this.#drain();
      });
    }
  }
  #run(pending: Pending): Promise<void> {
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { moduleUrl: JSONATA_MODULE_URL },
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      },
    });
    this.#workers.add(worker);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = async (result: ExpressionResult): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.request.signal?.removeEventListener('abort', onAbort);
      this.#workers.delete(worker);
      try {
        await worker.terminate();
      } finally {
        complete();
        pending.resolve(result);
      }
    };
    const onAbort = (): void => {
      void finish(error('canceled', 'evaluation canceled'));
    };
    pending.request.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('error', (cause: unknown) => {
      void finish(
        error(
          'evaluation_failed',
          cause instanceof Error ? cause.message : 'worker failed',
        ),
      );
    });
    worker.once('exit', (code) => {
      if (!settled)
        void finish(
          this.#closed
            ? error('canceled', 'evaluator shut down')
            : error(
                'evaluation_failed',
                `evaluator worker exited with code ${String(code)}`,
              ),
        );
    });
    worker.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') {
        void finish(error('evaluation_failed', 'invalid evaluator response'));
        return;
      }
      const response = message as {
        ready?: boolean;
        started?: boolean;
        ok?: boolean;
        missing?: boolean;
        value?: unknown;
        message?: string;
      };
      if (response.ready) {
        worker.postMessage({
          expression: pending.request.expression,
          context: pending.request.context,
        });
        return;
      }
      if (response.started) {
        timer = setTimeout(() => {
          void finish(
            error(
              'timed_out',
              `evaluation exceeded ${String(EXPRESSION_POLICY_V1.timeoutMs)} ms`,
            ),
          );
        }, EXPRESSION_POLICY_V1.timeoutMs);
        return;
      }
      if (!response.ok) {
        void finish(
          error('evaluation_failed', response.message ?? 'evaluation failed'),
        );
        return;
      }
      if (response.missing) {
        void finish({ kind: 'missing' });
        return;
      }
      try {
        const value = canonicalizeJson(response.value);
        const output = inspectJsonValue(value);
        for (const [limit, actual, maximum] of [
          ['output_bytes', output.bytes, EXPRESSION_POLICY_V1.outputBytes],
          ['output_depth', output.depth, EXPRESSION_POLICY_V1.outputDepth],
          [
            'output_members',
            output.members,
            EXPRESSION_POLICY_V1.outputMembers,
          ],
        ] as const)
          if (actual > maximum) {
            void finish(
              error('limit_exceeded', `${limit} exceeds policy`, limit),
            );
            return;
          }
        void finish({ kind: 'value', value, canonicalBytes: output.bytes });
      } catch (cause) {
        void finish(
          error(
            'evaluation_failed',
            cause instanceof Error ? cause.message : 'non-JSON result',
          ),
        );
      }
    });
    return completion;
  }
}

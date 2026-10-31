import { fork, type ChildProcess } from 'node:child_process';

import { inspectJsonValue, normalizeJson } from '../json/canonical.js';
import { isRecord } from '../json/object.js';
import {
  EXPRESSION_POLICY,
  expressionError,
  type ExpressionRequest,
  type ExpressionResult,
} from './policy.js';

const RUNTIME_URL = new URL(
  import.meta.url.endsWith('.ts')
    ? './evaluation-child.ts'
    : './evaluation-child.js',
  import.meta.url,
);

// The child gets no environment and none of the host's flags: it has no use for
// the host's secrets, and instrumentation preloads have no place in it.
// `--frozen-intrinsics` and `--disable-proto` exist because the process is shared:
// no evaluation can leave anything on a built-in for the next workspace to read.
const CHILD_FLAGS = [
  `--max-old-space-size=${String(EXPRESSION_POLICY.processHeapMb)}`,
  `--max-semi-space-size=${String(EXPRESSION_POLICY.processYoungGenerationMb)}`,
  '--disable-proto=delete',
  '--frozen-intrinsics',
];

// How V8 and native code end a process that ran out of memory. A plain exit or
// SIGKILL may come from the operating system or an operator instead.
const CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
  'SIGABRT',
  'SIGBUS',
  'SIGILL',
  'SIGSEGV',
  'SIGTRAP',
]);

export type ProcessEvaluation = Readonly<{
  request: ExpressionRequest;
  readsVariables: boolean;
  startupTimeoutMs: number;
}>;

export type ProcessOutcome = Readonly<{
  result: ExpressionResult;
  /** A process that was stopped or broke mid-evaluation is never used again. */
  reusable: boolean;
}>;

type Running = Readonly<{
  evaluation: ProcessEvaluation;
  finish: (outcome: ProcessOutcome) => void;
}>;

function outcomeFromMessage(
  message: Readonly<Record<string, unknown>>,
  readsVariables: boolean,
): ProcessOutcome {
  switch (message.kind) {
    case 'missing':
      return {
        reusable: true,
        result: readsVariables
          ? expressionError(
              'variable_missing',
              'This variable expression has no value. Check the captured workspace variables.',
            )
          : { kind: 'missing' },
      };
    case 'output_too_large':
      return {
        reusable: true,
        result: expressionError(
          'limit_exceeded',
          'output_bytes exceeds policy',
          'output_bytes',
        ),
      };
    case 'failed':
      return {
        reusable: true,
        result: expressionError(
          'evaluation_failed',
          typeof message.message === 'string'
            ? message.message
            : 'evaluation failed',
        ),
      };
    case 'value':
      return { reusable: true, result: boundedValue(message.value) };
    default:
      return {
        reusable: false,
        result: expressionError('unavailable', 'invalid evaluator response'),
      };
  }
}

function boundedValue(raw: unknown): ExpressionResult {
  try {
    const value = normalizeJson(raw);
    const output = inspectJsonValue(value);
    for (const [limit, actual, maximum] of [
      ['output_bytes', output.bytes, EXPRESSION_POLICY.outputBytes],
      ['output_depth', output.depth, EXPRESSION_POLICY.outputDepth],
      ['output_members', output.members, EXPRESSION_POLICY.outputMembers],
    ] as const)
      if (actual > maximum)
        return expressionError(
          'limit_exceeded',
          `${limit} exceeds policy`,
          limit,
        );
    return { kind: 'value', value, canonicalBytes: output.bytes };
  } catch (cause) {
    return expressionError(
      'evaluation_failed',
      cause instanceof Error ? cause.message : 'non-JSON result',
    );
  }
}

/** One reusable child process, running one evaluation at a time. */
export class EvaluationProcess {
  readonly #child: ChildProcess;
  readonly #exited: Promise<void>;
  #ready = false;
  #gone = false;
  #running: Running | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #onAbort: (() => void) | undefined;

  constructor(onGone: () => void) {
    this.#child = fork(RUNTIME_URL, [], {
      env: {},
      execArgv: CHILD_FLAGS,
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.#exited = new Promise((resolve) => {
      this.#child.once('close', () => {
        onGone();
        resolve();
      });
      // A process that never started has no exit to wait for.
      this.#child.once('error', () => {
        if (this.#child.pid !== undefined) return;
        onGone();
        resolve();
      });
    });
    this.#child.on('message', (message) => {
      this.#read(message);
    });
    // Also emitted when a signal can't be delivered, so it isn't always the end.
    this.#child.on('error', () => {
      if (this.#child.pid === undefined) this.#gone = true;
      this.#end({
        reusable: false,
        result: expressionError('unavailable', 'evaluator process failed'),
      });
    });
    this.#child.once('exit', (code, signal) => {
      this.#gone = true;
      this.#end({
        reusable: false,
        result:
          signal !== null && CRASH_SIGNALS.has(signal)
            ? expressionError(
                'limit_exceeded',
                'The expression used more memory than allowed',
                'memory',
              )
            : expressionError(
                'unavailable',
                `evaluator process stopped (${String(signal ?? code)})`,
              ),
      });
    });
  }

  get gone(): boolean {
    return this.#gone;
  }

  run(evaluation: ProcessEvaluation): Promise<ProcessOutcome> {
    return new Promise((resolve) => {
      this.#running = { evaluation, finish: resolve };
      const { signal } = evaluation.request;
      this.#onAbort = () => {
        this.#end({
          reusable: false,
          result: expressionError('canceled', 'evaluation canceled'),
        });
      };
      signal?.addEventListener('abort', this.#onAbort, { once: true });
      this.#child.ref();
      this.#child.channel?.ref();
      // Covers process start and handing the input over. Scheduler delay on a
      // loaded host isn't evaluation time.
      this.#timer = setTimeout(() => {
        this.#end({
          reusable: false,
          result: expressionError('unavailable', 'evaluator startup timed out'),
        });
      }, evaluation.startupTimeoutMs);
      if (this.#gone)
        this.#end({
          reusable: false,
          result: expressionError('unavailable', 'evaluator process stopped'),
        });
      else if (this.#ready) this.#send();
    });
  }

  /** An idle process must not keep its host alive. */
  release(): void {
    this.#child.unref();
    this.#child.channel?.unref();
  }

  /** Stopping can't fail: SIGKILL has no handler, so the only wait is for the exit. */
  async stop(): Promise<void> {
    this.#end({
      reusable: false,
      result: expressionError('canceled', 'evaluator shut down'),
    });
    if (!this.#gone) {
      // Waiting for the exit must keep the host's event loop alive.
      this.#child.ref();
      this.#child.channel?.ref();
      this.#child.kill('SIGKILL');
    }
    await this.#exited;
  }

  #send(): void {
    const running = this.#running;
    if (running === undefined) return;
    const { expression, context } = running.evaluation.request;
    this.#child.send(
      { expression, context, outputBytes: EXPRESSION_POLICY.outputBytes },
      (cause) => {
        if (cause !== null)
          this.#end({
            reusable: false,
            result: expressionError('unavailable', 'evaluator handoff failed'),
          });
      },
    );
  }

  #read(message: unknown): void {
    if (!isRecord(message)) {
      this.#end({
        reusable: false,
        result: expressionError('unavailable', 'invalid evaluator response'),
      });
      return;
    }
    if (message.kind === 'ready') {
      this.#ready = true;
      this.#send();
      return;
    }
    const running = this.#running;
    if (running === undefined) return;
    if (message.kind === 'started') {
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        this.#end({
          reusable: false,
          result: expressionError(
            'timed_out',
            `evaluation exceeded ${String(EXPRESSION_POLICY.timeoutMs)} ms`,
          ),
        });
      }, EXPRESSION_POLICY.timeoutMs);
      return;
    }
    this.#end(outcomeFromMessage(message, running.evaluation.readsVariables));
  }

  #end(outcome: ProcessOutcome): void {
    const running = this.#running;
    if (running === undefined) return;
    this.#running = undefined;
    clearTimeout(this.#timer);
    if (this.#onAbort !== undefined)
      running.evaluation.request.signal?.removeEventListener(
        'abort',
        this.#onAbort,
      );
    if (outcome.reusable) {
      running.finish(outcome);
      return;
    }
    // The capacity stays taken until the process is really gone.
    if (!this.#gone) this.#child.kill('SIGKILL');
    void this.#exited.then(() => {
      running.finish(outcome);
    });
  }
}

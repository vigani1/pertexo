import type { Worker } from 'node:worker_threads';
import { inspectJsonValue, normalizeJson } from '../json/canonical.js';
import {
  EXPRESSION_POLICY,
  expressionError,
  type ExpressionRequest,
  type ExpressionResult,
} from './policy.js';
export interface Pending {
  readonly request: ExpressionRequest;
  readonly readsVariables: boolean;
  readonly resolve: (result: ExpressionResult) => void;
  queuedAbort: (() => void) | undefined;
}
export function evaluatorMessageHandler({
  worker,
  pending,
  finish,
  beginEvaluation,
}: Readonly<{
  worker: Worker;
  pending: Pending;
  finish: (result: ExpressionResult) => Promise<void>;
  beginEvaluation: () => void;
}>): (message: unknown) => void {
  let handedOff = false;
  let started = false;
  return (message: unknown): void => {
    if (!message || typeof message !== 'object') {
      void finish(
        expressionError('evaluation_failed', 'invalid evaluator response'),
      );
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
      if (handedOff) {
        void finish(
          expressionError('evaluation_failed', 'duplicate evaluator readiness'),
        );
        return;
      }
      handedOff = true;
      try {
        worker.postMessage({
          expression: pending.request.expression,
          context: pending.request.context,
        });
      } catch (cause: unknown) {
        void finish(
          expressionError(
            'evaluation_failed',
            cause instanceof Error ? cause.message : 'worker handoff failed',
          ),
        );
      }
      return;
    }
    if (response.started) {
      if (!handedOff) {
        void finish(
          expressionError(
            'evaluation_failed',
            'evaluator started before readiness',
          ),
        );
        return;
      }
      if (started) {
        void finish(
          expressionError('evaluation_failed', 'duplicate evaluator start'),
        );
        return;
      }
      started = true;
      beginEvaluation();
      return;
    }
    if (!started) {
      void finish(
        expressionError('evaluation_failed', 'evaluator result before start'),
      );
      return;
    }
    if (!response.ok) {
      void finish(
        expressionError(
          'evaluation_failed',
          response.message ?? 'evaluation failed',
        ),
      );
      return;
    }
    if (response.missing) {
      void finish(
        pending.readsVariables
          ? expressionError(
              'variable_missing',
              'This variable expression has no value. Check the captured workspace variables.',
            )
          : { kind: 'missing' },
      );
      return;
    }
    try {
      const value = normalizeJson(response.value);
      const output = inspectJsonValue(value);
      for (const [limit, actual, maximum] of [
        ['output_bytes', output.bytes, EXPRESSION_POLICY.outputBytes],
        ['output_depth', output.depth, EXPRESSION_POLICY.outputDepth],
        ['output_members', output.members, EXPRESSION_POLICY.outputMembers],
      ] as const)
        if (actual > maximum) {
          void finish(
            expressionError('limit_exceeded', `${limit} exceeds policy`, limit),
          );
          return;
        }
      void finish({ kind: 'value', value, canonicalBytes: output.bytes });
    } catch (cause) {
      void finish(
        expressionError(
          'evaluation_failed',
          cause instanceof Error ? cause.message : 'non-JSON result',
        ),
      );
    }
  };
}

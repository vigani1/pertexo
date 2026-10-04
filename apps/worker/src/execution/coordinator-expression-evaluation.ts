import {
  JsonataEvaluator,
  type ExpressionEvaluator,
} from '@pertexo/workflow-model/expressions';
import type { CoordinatorRunStore } from '@pertexo/database/execution';

export type CoordinatorExpressionEvaluation = Readonly<{
  evaluator?: ExpressionEvaluator;
  close(): Promise<void>;
}>;

/** Forward to the one resource after composition; never allocate or cache material. */
export function createCoordinatorExpressionEvaluatorForwarding(
  current: () => CoordinatorExpressionEvaluation | undefined,
): ExpressionEvaluator {
  return Object.freeze<ExpressionEvaluator>({
    evaluate: (request) => {
      const evaluator = current()?.evaluator;
      if (evaluator === undefined)
        throw new Error(
          'Native coordinator expression evaluator is unavailable',
        );
      return evaluator.evaluate(request);
    },
  });
}

/** One existing evaluator only for the actual release-admitted native ports.
 * Borrowed evaluators remain caller-owned; retained/native-OFF allocates none.
 */
export function createCoordinatorExpressionEvaluation(
  runStore: CoordinatorRunStore,
  borrowed?: ExpressionEvaluator,
  factory: () => JsonataEvaluator = () => new JsonataEvaluator(),
): CoordinatorExpressionEvaluation {
  if (
    runStore.loadCallableCompletionSources === undefined ||
    runStore.readCallableCompletionSource === undefined ||
    runStore.inspectCoordinatorValueReadOwner === undefined
  )
    return { close: () => Promise.resolve() };
  const owned = borrowed === undefined ? factory() : undefined;
  const evaluator = borrowed ?? owned;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    ...(evaluator === undefined ? {} : { evaluator }),
    close: () => (closePromise ??= owned?.shutdown() ?? Promise.resolve()),
  });
}

import type { JsonValue } from '@pertexo/workflow-model';
import { WorkflowEngineError } from '../errors.js';
import type { WorkflowTransitionPlan } from '../types.js';

export type CallableResultDecision =
  | Readonly<{ kind: 'valid'; value: JsonValue }>
  | Readonly<{
      kind: 'invalid';
      reasonCode:
        | 'callable_result_missing'
        | 'callable_result_ambiguous'
        | 'callable_result_invalid'
        | 'callable_result_bounds';
    }>;

/** Success is provisional until the declared result has passed completion validation. */
export function settleCallableResult(
  plan: WorkflowTransitionPlan,
  result: CallableResultDecision,
): WorkflowTransitionPlan {
  if (
    plan.checkpoint.runStatus !== 'succeeded' ||
    plan.events.filter(({ name }) => name === 'run.succeeded').length !== 1
  )
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'callable completion requires a fresh success decision',
    );
  if (result.kind === 'valid') return { ...plan, runResult: result.value };
  return {
    ...plan,
    checkpoint: { ...plan.checkpoint, runStatus: 'failed' },
    events: plan.events.map((event) =>
      event.name === 'run.succeeded'
        ? { ...event, name: 'run.failed', reasonCode: result.reasonCode }
        : event,
    ),
  };
}

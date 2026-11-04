import type { RunFailureCode } from '@pertexo/workflow-model';

const explanations: ReadonlyMap<string, string> = new Map(
  Object.entries({
    'execution.run_state_invalid':
      'The run’s saved execution state is invalid. Ask an administrator to check the worker and database before replaying.',
    'execution.checkpoint_missing':
      'The run’s saved checkpoint is missing. Ask an administrator to check the database before replaying.',
    callable_result_missing:
      'The workflow did not produce its declared result. Fix the result mapping and publish again.',
    callable_result_variable_missing:
      'The workflow’s declared result needs an unavailable variable. Fix the variable or result mapping and publish again.',
    callable_result_ambiguous:
      'The workflow’s declared result has more than one possible source. Fix the result mapping and publish again.',
    callable_result_invalid:
      'The workflow’s result does not match its declared result type. Fix the result mapping or type and publish again.',
    callable_result_timed_out:
      'The workflow’s result could not be evaluated in time. Simplify the result mapping and publish again.',
    callable_result_bounds:
      'The workflow’s result exceeds the supported size. Reduce the result and publish again.',
  } satisfies Record<RunFailureCode, string>),
);

export function describeRunFailureReason(
  code: string | null | undefined,
): string | undefined {
  return code == null ? undefined : explanations.get(code);
}

import {
  MappingExecutorFailure,
  MappingRefusalError,
  type MappingRefusal,
} from '@pertexo/workflow-engine/server';

/** Render only the engine's safe facts at the run/preview product boundary. */
export function describeMappingFailure(error: unknown): string | undefined {
  if (
    !(error instanceof MappingRefusalError) &&
    !(error instanceof MappingExecutorFailure)
  )
    return undefined;
  const reason = error.diagnostic;
  const field = identifier(reason.mappingKey, 64);
  switch (reason.kind) {
    case 'nonfinite_result':
      return `Expression for field ${field} returned a nonfinite number. Reduce the numeric result or check for division by zero.`;
    case 'variable_missing':
      return reason.variable.kind === 'named'
        ? `Input ${field} uses missing workspace variable ${identifier(reason.variable.name, 64)}. Add it in Settings → Variables or update this mapping.`
        : `Expression for field ${field} has no variable value. Check the captured workspace variables or provide a fallback.`;
    case 'invalid_path':
      return `Input ${field} (${SOURCE_LABELS[reason.sourceKind]}) uses unsupported path ${identifier(reason.path, 128)}. Use a path such as $.customer.email or $[0].`;
    case 'expression_timeout':
      return `Expression for field ${field} exceeded the ${String(reason.maximumMs)} ms evaluation limit. Simplify the calculation or use less data; Pertexo retries while attempts remain.`;
    case 'pool_capacity':
      return `Expression for field ${field} could not start: the evaluator queue reached its ${String(reason.maximumQueued)} waiting-evaluation limit. Retry when the server is less busy.`;
    case 'expression_unavailable':
      return `Expression for field ${field} could not start because its evaluator was unavailable. Pertexo retries while attempts remain.`;
    case 'expression_limit': {
      const [dimension, unit, remedy] = LIMIT_COPY[reason.limit];
      return `Expression for field ${field} exceeded the ${dimension} limit of ${String(reason.maximum)} ${unit}. ${remedy}`;
    }
    case 'expression_failed':
      return `Expression for field ${field} could not be evaluated. Check its syntax and the data it reads.`;
  }
}

const SOURCE_LABELS: Record<MappingRefusal['sourceKind'], string> = {
  run_input: 'run input',
  node_output: 'step output',
  node_failure: 'step failure',
  structured_input: 'loop input',
  expression: 'expression',
  workspace_variable: 'workspace variable',
  literal: 'literal',
};
const LIMIT_COPY: Record<
  Extract<MappingRefusal, { kind: 'expression_limit' }>['limit'],
  readonly [string, string, string]
> = {
  expression_bytes: [
    'source size',
    'bytes',
    'Shorten the expression or split the calculation into steps.',
  ],
  ast_depth: [
    'syntax depth',
    'levels',
    'Reduce nesting or split the calculation into steps.',
  ],
  ast_nodes: [
    'syntax size',
    'nodes',
    'Simplify the expression or split the calculation into steps.',
  ],
  input_bytes: ['input size', 'bytes', 'Pass less data to the expression.'],
  input_depth: [
    'input depth',
    'levels',
    'Flatten the data passed to the expression.',
  ],
  input_members: [
    'input fields/items',
    'members',
    'Pass fewer fields or items to the expression.',
  ],
  output_bytes: [
    'output size',
    'bytes',
    'Return less data from the expression.',
  ],
  output_depth: ['output depth', 'levels', 'Return a shallower result.'],
  output_members: [
    'output fields/items',
    'members',
    'Return fewer fields or items.',
  ],
  memory: [
    'heap memory',
    'MiB',
    'Work on less data or split the calculation into steps.',
  ],
  pool_capacity: [
    'evaluator queue',
    'waiting evaluations',
    'Retry when the server is less busy.',
  ],
};

function identifier(value: string, maximum: number): string {
  // JSON quoting can expand a character sixfold; leave room in the stored summary.
  return JSON.stringify(
    value.length > maximum ? `${value.slice(0, maximum)}…` : value,
  );
}

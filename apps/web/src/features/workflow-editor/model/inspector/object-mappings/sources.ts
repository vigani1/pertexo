import {
  isRecord,
  parseJsonPath,
  workspaceVariableNameSchema,
  type ValueSource,
} from '@pertexo/workflow-model';
import { propertyPath } from '../input-mappings';

export function valueExpression(source: ValueSource): string | undefined {
  switch (source.kind) {
    case 'literal':
      return JSON.stringify(source.value);
    case 'expression':
      return source.expression;
    case 'workspace_variable':
      return `$vars.${source.name}`;
    case 'run_input':
      return pathExpression('runInput', source.path);
    case 'node_output':
      return pathExpression(
        `nodeOutputs.${JSON.stringify(source.nodeId)}`,
        source.path,
      );
    default:
      return undefined;
  }
}
function pathExpression(root: string, path: string) {
  const segments = parseJsonPath(path);
  return segments === undefined
    ? undefined
    : segments.reduce<string>(
        (result, part) =>
          typeof part === 'number'
            ? `${result}[${String(part)}]`
            : `${result}.${JSON.stringify(part)}`,
        root,
      );
}

/** Recognize only the exact expressions emitted by the value picker. */
export function sourceFromExpression(
  ast: unknown,
  expression: string,
): ValueSource | undefined {
  if (!isRecord(ast)) return undefined;
  const steps: unknown[] =
    ast.type === 'path' && Array.isArray(ast.steps) ? ast.steps : [ast];
  const root = steps[0],
    second = steps[1];
  if (!isRecord(root)) return undefined;
  let source: ValueSource | undefined;
  const workspaceVariablePath =
    root.type === 'variable' &&
    root.value === 'vars' &&
    isRecord(second) &&
    second.type === 'name' &&
    steps.length === 2;
  if (workspaceVariablePath) {
    const name = workspaceVariableNameSchema.safeParse(second.value);
    if (name.success) source = { kind: 'workspace_variable', name: name.data };
  } else if (root.type === 'name' && root.value === 'runInput') {
    const path = readPath(steps);
    if (path !== undefined) source = { kind: 'run_input', path };
  } else {
    const nodeOutputPath =
      root.type === 'name' &&
      root.value === 'nodeOutputs' &&
      isRecord(second) &&
      second.type === 'name';
    if (nodeOutputPath && typeof second.value === 'string') {
      const path = readPath(steps.slice(1));
      if (path !== undefined)
        source = { kind: 'node_output', nodeId: second.value, path };
    }
  }
  // More elaborate paths, predicates, blocks and comments remain expressions.
  return source !== undefined && valueExpression(source) === expression
    ? source
    : undefined;
}
function readPath(steps: readonly unknown[]): string | undefined {
  let path = '$';
  for (const [index, step] of steps.entries()) {
    if (
      !isRecord(step) ||
      step.type !== 'name' ||
      typeof step.value !== 'string'
    )
      return undefined;
    if (index > 0) path += propertyPath(step.value).slice(1);
    if (step.stages === undefined) continue;
    if (!Array.isArray(step.stages)) return undefined;
    for (const stage of step.stages) {
      if (!isArrayIndexFilter(stage)) return undefined;
      path += `[${String(stage.expr.value)}]`;
    }
  }
  return path;
}

function isArrayIndexFilter(
  stage: unknown,
): stage is { type: 'filter'; expr: { type: 'number'; value: number } } {
  return (
    isRecord(stage) &&
    stage.type === 'filter' &&
    isRecord(stage.expr) &&
    stage.expr.type === 'number' &&
    typeof stage.expr.value === 'number' &&
    Number.isSafeInteger(stage.expr.value) &&
    stage.expr.value >= 0
  );
}

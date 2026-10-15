import { isRecord } from '../json/object.js';

export type ExpressionVariableReferences = Readonly<{
  names: readonly string[];
  requiredNames: readonly string[];
  dynamic: boolean;
}>;
/** Called only after the ordinary AST budget check; strings are never reparsed as expressions. */
export function expressionVariableReferences(
  root: unknown,
): ExpressionVariableReferences {
  const names = new Set<string>();
  const requiredNames = new Set<string>();
  let dynamic = false;
  function visit(value: unknown, covered = false): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === 'path' && Array.isArray(value.steps)) {
      const first: unknown = value.steps[0],
        second: unknown = value.steps[1];
      if (
        isRecord(first) &&
        first.type === 'variable' &&
        first.value === 'vars' &&
        isRecord(second) &&
        second.type === 'name' &&
        typeof second.value === 'string' &&
        first.predicate === undefined
      ) {
        names.add(second.value);
        requiredNames.add(second.value);
        for (const [key, child] of Object.entries(value)) {
          if (key === 'steps') {
            for (const [index, step] of value.steps.entries())
              visit(step, index === 0);
          } else if (!['value', 'type', 'position'].includes(key)) visit(child);
        }
        return;
      }
    }
    if (
      value.type === 'function' &&
      isRecord(value.procedure) &&
      value.procedure.type === 'variable' &&
      value.procedure.value === 'lookup' &&
      Array.isArray(value.arguments)
    ) {
      const first: unknown = value.arguments[0],
        second: unknown = value.arguments[1];
      if (
        isRecord(first) &&
        first.type === 'variable' &&
        first.value === 'vars' &&
        first.predicate === undefined &&
        isRecord(second) &&
        second.type === 'string' &&
        typeof second.value === 'string'
      ) {
        names.add(second.value);
        for (const [key, child] of Object.entries(value)) {
          if (key === 'arguments') {
            for (const [index, argument] of value.arguments.entries())
              visit(argument, index === 0);
          } else if (!['value', 'type', 'position'].includes(key)) visit(child);
        }
        return;
      }
    }
    if (value.type === 'variable' && value.value === 'vars' && !covered)
      dynamic = true;
    for (const [key, child] of Object.entries(value))
      if (!['value', 'type', 'position'].includes(key)) visit(child);
  }
  visit(root);
  return {
    names: [...names].sort(),
    requiredNames: [...requiredNames].sort(),
    dynamic,
  };
}

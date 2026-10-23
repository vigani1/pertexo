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
  function visit(
    value: unknown,
    options: Readonly<{ covered?: boolean }> = {},
  ): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const direct = directVariable(value);
    if (direct !== undefined) {
      names.add(direct.name);
      requiredNames.add(direct.name);
      visitVariableChildren(value, 'steps', direct.items, visit);
      return;
    }
    const lookup = lookupVariable(value);
    if (lookup !== undefined) {
      names.add(lookup.name);
      visitVariableChildren(value, 'arguments', lookup.items, visit);
      return;
    }
    const unboundVariable =
      value.type === 'variable' && value.value === 'vars' && !options.covered;
    if (unboundVariable) dynamic = true;
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

function directVariable(
  value: Record<string, unknown>,
): Readonly<{ name: string; items: unknown[] }> | undefined {
  if (value.type !== 'path' || !Array.isArray(value.steps)) return undefined;
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
  )
    return { name: second.value, items: value.steps };
  return undefined;
}

function lookupVariable(
  value: Record<string, unknown>,
): Readonly<{ name: string; items: unknown[] }> | undefined {
  if (!isVariableLookup(value)) return undefined;
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
  )
    return { name: second.value, items: value.arguments };
  return undefined;
}

function isVariableLookup(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { arguments: unknown[] } {
  return (
    value.type === 'function' &&
    isRecord(value.procedure) &&
    value.procedure.type === 'variable' &&
    value.procedure.value === 'lookup' &&
    Array.isArray(value.arguments)
  );
}

function visitVariableChildren(
  value: Record<string, unknown>,
  argumentKey: 'steps' | 'arguments',
  arguments_: unknown[],
  visit: (value: unknown, options?: Readonly<{ covered?: boolean }>) => void,
): void {
  for (const [key, child] of Object.entries(value)) {
    if (key === argumentKey) {
      for (const [index, argument] of arguments_.entries())
        visit(argument, { covered: index === 0 });
    } else if (!['value', 'type', 'position'].includes(key)) visit(child);
  }
}

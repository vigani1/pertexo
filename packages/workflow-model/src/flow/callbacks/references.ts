import { isRecord } from '../../values/json/object.js';

// JSONata AST shapes of a static callback reference: `$execution.callbacks.<id>.url`
// is four path steps; `$lookup($execution.callbacks, "<id>").url` is two, with a
// two-argument lookup whose owner is the two-step `$execution.callbacks`.
const CALLBACK_AST = Object.freeze({
  executionPathSteps: 4,
  lookupPathSteps: 2,
  lookupArguments: 2,
  callbacksOwnerSteps: 2,
});
export type CallbackReference = Readonly<{
  nodeId: string;
  field: 'url' | 'secret';
}>;

function plain(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
  );
}
function named(value: unknown, type: string, name: string): boolean {
  return (
    plain(value, ['type', 'value', 'position']) &&
    value.type === type &&
    value.value === name
  );
}
function reference(
  value: Record<string, unknown>,
): CallbackReference | undefined {
  if (
    !plain(value, ['type', 'steps', 'position']) ||
    value.type !== 'path' ||
    !Array.isArray(value.steps)
  )
    return undefined;
  const steps: unknown[] = value.steps;
  const last = steps.at(-1);
  if (!isCallbackField(last)) return undefined;
  const nodeId = callbackNodeId(steps);
  return typeof nodeId === 'string' ? { nodeId, field: last.value } : undefined;
}

/** Binding leaves may be placed in ordinary objects/arrays, never transformed. */
export function callbackReferences(root: unknown): Readonly<{
  references: readonly CallbackReference[];
  invalid: boolean;
}> {
  const references = new Map<string, CallbackReference>();
  let invalid = false;
  function visit(
    value: unknown,
    options: Readonly<{ allowLeaf?: boolean }> = {},
  ): void {
    const allowLeaf = options.allowLeaf ?? false;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    const leaf = reference(value);
    if (leaf !== undefined) {
      if (allowLeaf) references.set(`${leaf.nodeId}:${leaf.field}`, leaf);
      else invalid = true;
      return;
    }
    if (value.type === 'variable' && value.value === 'execution')
      invalid = true;
    const container = bindingChildren(value);
    if (container !== undefined) {
      switch (container.kind) {
        case 'block':
          visit(container.values[0], { allowLeaf });
          return;
        case 'object':
          for (const pair of container.values) {
            if (!Array.isArray(pair)) continue;
            visit(pair[0]);
            visit(pair[1], { allowLeaf });
          }
          return;
        case 'array':
          for (const child of container.values) visit(child, { allowLeaf });
          return;
      }
    }
    for (const [key, child] of Object.entries(value))
      if (!['type', 'value', 'position'].includes(key)) visit(child);
  }
  visit(root, { allowLeaf: true });
  return { references: [...references.values()], invalid };
}

/** Copying a sender and its Wait keeps their static binding together. */
export function remapCallbackReferences(
  expression: string,
  root: unknown,
  ids: ReadonlyMap<string, string>,
): string {
  if (callbackReferences(root).invalid) return expression;
  const edits: { start: number; end: number; value: string }[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    const binding = reference(value);
    const replacement =
      binding === undefined ? undefined : ids.get(binding.nodeId);
    if (
      binding !== undefined &&
      replacement !== undefined &&
      Array.isArray(value.steps)
    ) {
      const steps: unknown[] = value.steps;
      const first = steps[0],
        last = steps.at(-1);
      const procedure =
        isRecord(first) && first.type === 'function' ? first.procedure : first;
      const span = callbackSourceSpan(procedure, last);
      if (span !== undefined && expression[span.start] === '$')
        edits.push({
          ...span,
          value: `$lookup($execution.callbacks,${JSON.stringify(replacement)}).${binding.field}`,
        });

      return;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(root);
  let result = expression;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

function callbackNodeId(steps: unknown[]): unknown {
  let nodeId: unknown;
  if (
    steps.length === CALLBACK_AST.executionPathSteps &&
    named(steps[0], 'variable', 'execution') &&
    named(steps[1], 'name', 'callbacks')
  ) {
    const target = steps[2];
    if (plain(target, ['type', 'value', 'position']) && target.type === 'name')
      nodeId = target.value;
  } else if (steps.length === CALLBACK_AST.lookupPathSteps) {
    const lookup = steps[0];
    nodeId = lookupCallbackNodeId(lookup);
  }
  return nodeId;
}

function lookupCallbackNodeId(lookup: unknown): unknown {
  let nodeId: unknown;
  if (
    plain(lookup, [
      'type',
      'name',
      'value',
      'position',
      'arguments',
      'procedure',
    ]) &&
    lookup.type === 'function' &&
    lookup.name === undefined &&
    named(lookup.procedure, 'variable', 'lookup') &&
    Array.isArray(lookup.arguments) &&
    lookup.arguments.length === CALLBACK_AST.lookupArguments
  ) {
    const [owner, target] = lookup.arguments as unknown[];
    if (
      plain(owner, ['type', 'steps', 'position']) &&
      owner.type === 'path' &&
      Array.isArray(owner.steps) &&
      owner.steps.length === CALLBACK_AST.callbacksOwnerSteps &&
      named(owner.steps[0], 'variable', 'execution') &&
      named(owner.steps[1], 'name', 'callbacks') &&
      plain(target, ['type', 'value', 'position']) &&
      target.type === 'string'
    )
      nodeId = target.value;
  }
  return nodeId;
}

function bindingChildren(
  value: Record<string, unknown>,
):
  | Readonly<{ kind: 'block' | 'object' | 'array'; values: unknown[] }>
  | undefined {
  if (
    plain(value, ['type', 'position', 'expressions']) &&
    value.type === 'block' &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 1
  )
    return { kind: 'block', values: value.expressions };
  if (
    plain(value, ['type', 'value', 'position', 'lhs']) &&
    value.type === 'unary' &&
    value.value === '{' &&
    Array.isArray(value.lhs)
  )
    return { kind: 'object', values: value.lhs };
  if (
    plain(value, ['type', 'value', 'position', 'expressions']) &&
    value.type === 'unary' &&
    value.value === '[' &&
    Array.isArray(value.expressions)
  )
    return { kind: 'array', values: value.expressions };
  return undefined;
}

function isCallbackField(value: unknown): value is Record<string, unknown> & {
  type: 'name';
  value: 'url' | 'secret';
} {
  return (
    plain(value, ['type', 'value', 'position']) &&
    value.type === 'name' &&
    (value.value === 'url' || value.value === 'secret')
  );
}

function callbackSourceSpan(
  procedure: unknown,
  last: unknown,
): Readonly<{ start: number; end: number }> | undefined {
  if (
    isRecord(procedure) &&
    isRecord(last) &&
    typeof procedure.position === 'number' &&
    typeof last.position === 'number'
  )
    return {
      start:
        procedure.position -
        (procedure.value === 'lookup' ? '$lookup' : '$execution').length,
      end: last.position,
    };
  return undefined;
}

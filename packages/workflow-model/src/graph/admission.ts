export interface WorkflowGraphAdmissionLimits {
  readonly graphBytes: number;
  readonly inputDepth: number;
  readonly jsonValueDepth: number;
  readonly structuredDepth: number;
}

export interface WorkflowGraphAdmissionOptions {
  /** Let the structural Zod schema retain its browser-facing number diagnostic. */
  readonly allowNonFiniteNumbers?: boolean;
}

type WorkflowGraphAdmissionFailure = Readonly<{
  ok: false;
  code:
    'structured_depth' | 'json_value_depth' | 'invalid_json' | 'graph_limit';
  path: string;
  message: string;
}>;

export type WorkflowGraphAdmission =
  | Readonly<{ ok: true; snapshot: unknown; bytes: number }>
  | WorkflowGraphAdmissionFailure;

type JsonContainer = Record<string, unknown> | unknown[];

type Frame =
  | Readonly<{
      kind: 'enter';
      value: unknown;
      path: string;
      depth: number;
      parent: JsonContainer | undefined;
      key: string | number | undefined;
    }>
  | Readonly<{ kind: 'exit'; source: object; target: JsonContainer }>;

type EnterFrame = Extract<Frame, { readonly kind: 'enter' }>;

interface InspectionState {
  readonly stack: Frame[];
  readonly ancestors: Set<object>;
  bytes: number;
  root: unknown;
}

function failure(
  code: WorkflowGraphAdmissionFailure['code'],
  path: string,
  message: string,
): WorkflowGraphAdmissionFailure {
  return { ok: false, code, path, message };
}

function utf8JsonBytes(value: string | number | boolean | null): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assign(
  parent: JsonContainer | undefined,
  key: string | number | undefined,
  value: unknown,
): unknown {
  if (parent === undefined) return value;
  if (Array.isArray(parent)) parent[key as number] = value;
  else
    Object.defineProperty(parent, key as string, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  return undefined;
}

function assignInspectedValue(
  state: InspectionState,
  frame: EnterFrame,
  value: unknown,
): void {
  const assigned = assign(frame.parent, frame.key, value);
  if (frame.parent === undefined) state.root = assigned;
}

function inspectArrayUnsafe(
  value: object,
  frame: EnterFrame,
  state: InspectionState,
  limits: WorkflowGraphAdmissionLimits,
): WorkflowGraphAdmissionFailure | undefined {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  )
    return failure('invalid_json', frame.path, 'array properties are not JSON');
  const length = lengthDescriptor.value as number;
  const minimumBytes = 2 + Math.max(0, length - 1);
  if (minimumBytes > limits.graphBytes - state.bytes)
    return failure('graph_limit', '$', 'graph bytes exceed the graph limit');
  if (Object.getOwnPropertySymbols(value).length > 0)
    return failure(
      'invalid_json',
      frame.path,
      'symbol properties are not JSON',
    );
  state.bytes += minimumBytes;
  const target = new Array<unknown>(length);
  assignInspectedValue(state, frame, target);
  state.ancestors.add(value);
  state.stack.push({ kind: 'exit', source: value, target });
  for (let index = length - 1; index >= 0; index -= 1) {
    const path = `${frame.path}[${String(index)}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      return failure('invalid_json', path, 'sparse arrays are not JSON');
    if (!('value' in descriptor))
      return failure(
        'invalid_json',
        path,
        'accessors are not valid graph input',
      );
    state.stack.push({
      kind: 'enter',
      value: descriptor.value,
      path,
      depth: frame.depth + 1,
      parent: target,
      key: index,
    });
  }
  return undefined;
}

function inspectObjectUnsafe(
  value: object,
  frame: EnterFrame,
  state: InspectionState,
  limits: WorkflowGraphAdmissionLimits,
): WorkflowGraphAdmissionFailure | undefined {
  if (Object.getOwnPropertySymbols(value).length > 0)
    return failure(
      'invalid_json',
      frame.path,
      'symbol properties are not JSON',
    );
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    return failure('invalid_json', frame.path, 'object must be plain');

  const keys = Object.keys(value);
  state.bytes += 2 + Math.max(0, keys.length - 1);
  const target: Record<string, unknown> = {};
  assignInspectedValue(state, frame, target);
  state.ancestors.add(value);
  state.stack.push({ kind: 'exit', source: value, target });
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (key === undefined) continue;
    state.bytes += utf8JsonBytes(key) + 1;
    if (state.bytes > limits.graphBytes)
      return failure('graph_limit', '$', 'graph bytes exceed the graph limit');
    const path = `${frame.path}.${key}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor))
      return failure(
        'invalid_json',
        path,
        'accessors are not valid graph input',
      );
    state.stack.push({
      kind: 'enter',
      value: descriptor.value,
      path,
      depth: frame.depth + 1,
      parent: target,
      key,
    });
  }
  return state.bytes > limits.graphBytes
    ? failure('graph_limit', '$', 'graph bytes exceed the graph limit')
    : undefined;
}

function inspectJsonDocumentUnsafe(
  input: unknown,
  limits: WorkflowGraphAdmissionLimits,
  options: WorkflowGraphAdmissionOptions,
): WorkflowGraphAdmission {
  const state: InspectionState = {
    stack: [
      {
        kind: 'enter',
        value: input,
        path: '$',
        depth: 1,
        parent: undefined,
        key: undefined,
      },
    ],
    ancestors: new Set<object>(),
    bytes: 0,
    root: undefined,
  };

  while (state.stack.length > 0) {
    const frame = state.stack.pop();
    if (frame === undefined) continue;
    if (frame.kind === 'exit') {
      state.ancestors.delete(frame.source);
      Object.freeze(frame.target);
      continue;
    }
    if (frame.depth > limits.inputDepth)
      return failure(
        'json_value_depth',
        frame.path,
        `graph input depth exceeds ${String(limits.inputDepth)}`,
      );

    const value = frame.value;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' &&
        (Number.isFinite(value) || options.allowNonFiniteNumbers === true))
    ) {
      state.bytes += utf8JsonBytes(value);
      if (state.bytes > limits.graphBytes)
        return failure(
          'graph_limit',
          '$',
          'graph bytes exceed the graph limit',
        );
      assignInspectedValue(state, frame, value);
      continue;
    }
    if (typeof value !== 'object')
      return failure('invalid_json', frame.path, 'value is not JSON');
    if (state.ancestors.has(value))
      return failure('invalid_json', frame.path, 'cyclic values are not JSON');
    const issue = Array.isArray(value)
      ? inspectArrayUnsafe(value, frame, state, limits)
      : inspectObjectUnsafe(value, frame, state, limits);
    if (issue !== undefined) return issue;
  }

  return { ok: true, snapshot: state.root, bytes: state.bytes };
}

function valueDepthFailure(
  value: unknown,
  path: string,
  maximum: number,
): WorkflowGraphAdmissionFailure | undefined {
  const stack: { value: unknown; path: string; depth: number }[] = [
    { value, path, depth: 1 },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.depth > maximum)
      return failure(
        'json_value_depth',
        current.path,
        `JSON value depth exceeds ${String(maximum)}`,
      );
    if (current.value === null || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1)
        stack.push({
          value: current.value[index],
          path: `${current.path}[${String(index)}]`,
          depth: current.depth + 1,
        });
    } else {
      for (const key of Object.keys(current.value))
        stack.push({
          value: (current.value as Record<string, unknown>)[key],
          path: `${current.path}.${key}`,
          depth: current.depth + 1,
        });
    }
  }
  return undefined;
}

function inspectGraphFacts(
  snapshot: unknown,
  limits: WorkflowGraphAdmissionLimits,
): WorkflowGraphAdmissionFailure | undefined {
  const graphs: { value: unknown; path: string; depth: number }[] = [
    { value: snapshot, path: '$', depth: 0 },
  ];
  while (graphs.length > 0) {
    const current = graphs.pop();
    if (current === undefined || current.value === null) continue;
    if (current.depth > limits.structuredDepth)
      return failure(
        'structured_depth',
        current.path,
        `structured graph depth exceeds ${String(limits.structuredDepth)}`,
      );
    if (typeof current.value !== 'object' || Array.isArray(current.value))
      continue;
    const graph = current.value as Record<string, unknown>;
    const graphNodes: unknown = graph.nodes;
    if (!Array.isArray(graphNodes)) continue;
    for (let index = 0; index < graphNodes.length; index += 1) {
      const node: unknown = graphNodes[index];
      const nodePath = `${current.path}.nodes[${String(index)}]`;
      if (node === null || typeof node !== 'object' || Array.isArray(node))
        continue;
      const record = node as Record<string, unknown>;
      if (record.config !== undefined) {
        const issue = valueDepthFailure(
          record.config,
          `${nodePath}.config`,
          limits.jsonValueDepth,
        );
        if (issue !== undefined) return issue;
      }
      const mappings = record.inputMappings;
      if (
        mappings !== null &&
        typeof mappings === 'object' &&
        !Array.isArray(mappings)
      )
        for (const key of Object.keys(mappings)) {
          const mappingPath = `${nodePath}.inputMappings.${key}`;
          if (
            key === '__proto__' ||
            key === 'constructor' ||
            key === 'toString'
          )
            return failure(
              'invalid_json',
              mappingPath,
              'reserved input mapping key is not supported',
            );
          const mapping = (mappings as Record<string, unknown>)[key];
          if (
            mapping !== null &&
            typeof mapping === 'object' &&
            !Array.isArray(mapping) &&
            (mapping as Record<string, unknown>).kind === 'literal'
          ) {
            const issue = valueDepthFailure(
              (mapping as Record<string, unknown>).value,
              `${mappingPath}.value`,
              limits.jsonValueDepth,
            );
            if (issue !== undefined) return issue;
          }
        }
      const structured = record.structured;
      if (
        structured !== null &&
        typeof structured === 'object' &&
        !Array.isArray(structured)
      )
        graphs.push({
          value: (structured as Record<string, unknown>).body,
          path: `${nodePath}.structured.body`,
          depth: current.depth + 1,
        });
    }
  }
  return undefined;
}

/** Inspect graph input once into an immutable own-data snapshot. */
export function inspectWorkflowGraphAdmission(
  input: unknown,
  limits: WorkflowGraphAdmissionLimits,
  options: WorkflowGraphAdmissionOptions = {},
): WorkflowGraphAdmission {
  try {
    const inspected = inspectJsonDocumentUnsafe(input, limits, options);
    if (!inspected.ok) return inspected;
    const issue = inspectGraphFacts(inspected.snapshot, limits);
    return issue ?? inspected;
  } catch {
    return failure(
      'invalid_json',
      '$',
      'graph input could not be inspected safely',
    );
  }
}

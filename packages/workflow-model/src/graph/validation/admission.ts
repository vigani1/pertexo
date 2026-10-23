import { inspectGraphFacts } from './facts.js';
import {
  failure,
  type WorkflowGraphAdmissionLimits,
  type WorkflowGraphAdmissionOptions,
  type WorkflowGraphAdmissionFailure,
  type WorkflowGraphAdmission,
} from './admission-contract.js';
export type {
  WorkflowGraphAdmissionLimits,
  WorkflowGraphAdmissionOptions,
  WorkflowGraphAdmission,
} from './admission-contract.js';
import { jsonStringByteLength, utf8ByteLength } from '../../values/text.js';

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
    state.bytes +=
      jsonStringByteLength(key, {
        stopAfterBytes: limits.graphBytes - state.bytes - 1,
      }) + 1;
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
      const budget = { stopAfterBytes: limits.graphBytes - state.bytes };
      state.bytes +=
        typeof value === 'string'
          ? jsonStringByteLength(value, budget)
          : utf8ByteLength(JSON.stringify(value), budget);
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

import { inspectGraphFacts } from './facts.js';
import {
  failure,
  type WorkflowGraphAdmissionLimits,
  type WorkflowGraphAdmissionOptions,
  type WorkflowGraphAdmissionFailure,
  type WorkflowGraphAdmission,
} from './admission-result.js';
export type {
  WorkflowGraphAdmissionLimits,
  WorkflowGraphAdmissionOptions,
  WorkflowGraphAdmission,
} from './admission-result.js';
import {
  snapshotBoundedJson,
  type BoundedJsonPath,
} from '../../values/json/bounded-json-size.js';
import type { BoundedJsonSnapshotRefusal } from '../../values/json/bounded-json-walk.js';

// Graph input has no member or array bound of its own: its bytes bound it.
const UNBOUNDED_MEMBERS = Infinity;

const INVALID_JSON_MESSAGES: Readonly<
  Record<Exclude<BoundedJsonSnapshotRefusal, 'bytes' | 'depth'>, string>
> = Object.freeze({
  not_json: 'value is not JSON',
  cycle: 'cyclic values are not JSON',
  not_plain: 'object must be plain',
  sparse_array: 'sparse arrays are not JSON',
  array_extra_keys: 'array properties are not JSON',
  accessor: 'accessors are not valid graph input',
  symbol_key: 'symbol properties are not JSON',
  // Admission reads written properties only, sets no member bound and keeps
  // all text, so these can't occur; listed so every refusal has a message.
  hidden_property: 'value is not JSON',
  members: 'value is not JSON',
  array_items: 'value is not JSON',
  unstorable_text: 'value is not JSON',
});

/** Inspect graph input once into an immutable own-data snapshot. */
export function inspectWorkflowGraphAdmission(
  input: unknown,
  limits: WorkflowGraphAdmissionLimits,
  options: WorkflowGraphAdmissionOptions = {},
): WorkflowGraphAdmission {
  try {
    const inspected = snapshotGraphInput(input, limits, options);
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

function snapshotGraphInput(
  input: unknown,
  limits: WorkflowGraphAdmissionLimits,
  options: WorkflowGraphAdmissionOptions,
): WorkflowGraphAdmission {
  const snapshot = snapshotBoundedJson(
    input,
    {
      bytes: limits.graphBytes,
      depth: limits.inputDepth,
      members: UNBOUNDED_MEMBERS,
    },
    {
      // Graph input is read as JSON.stringify writes it, and its depth limits
      // count every value, as the graph's facts do.
      properties: 'written',
      depthCounts: 'values',
      allowNonFiniteNumbers: options.allowNonFiniteNumbers ?? false,
    },
  );
  if (snapshot.ok)
    return { ok: true, snapshot: snapshot.snapshot, bytes: snapshot.bytes };
  return refusalFailure(snapshot.refusal, snapshot.path, limits);
}

function refusalFailure(
  refusal: BoundedJsonSnapshotRefusal,
  path: BoundedJsonPath,
  limits: WorkflowGraphAdmissionLimits,
): WorkflowGraphAdmissionFailure {
  if (refusal === 'bytes')
    return failure('graph_limit', '$', 'graph bytes exceed the graph limit');
  if (refusal === 'depth')
    return failure(
      'json_value_depth',
      graphPath(path),
      `graph input depth exceeds ${String(limits.inputDepth)}`,
    );
  return failure(
    'invalid_json',
    graphPath(path),
    INVALID_JSON_MESSAGES[refusal],
  );
}

function graphPath(path: BoundedJsonPath): string {
  return path.reduce<string>(
    (joined, key) =>
      typeof key === 'number'
        ? `${joined}[${String(key)}]`
        : `${joined}.${key}`,
    '$',
  );
}

import {
  measureBoundedJson,
  type BoundedJsonSizeRefusal,
} from '@pertexo/workflow-model';

import { WorkflowEngineError } from '../workflow-engine.errors.js';
import { hasExactFields } from '../input-checks/exact-fields.js';

export const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const WORKFLOW_CHECKPOINT_LIMITS = Object.freeze({
  bytes: 262_144,
  depth: 64,
  members: 10_000,
  arrayItems: 10_000,
});

export function assertCheckpoint(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new WorkflowEngineError('checkpoint_invalid', message);
}

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  assertCheckpoint(
    hasExactFields(value, required, optional),
    'checkpoint contains missing or unknown fields',
  );
}

const CHECKPOINT_JSON_REFUSALS: Readonly<
  Record<BoundedJsonSizeRefusal, string>
> = {
  bytes: 'checkpoint exceeds maximum bytes',
  depth: 'checkpoint exceeds maximum depth',
  members: 'checkpoint exceeds maximum members',
  array_items: 'checkpoint array is oversized',
  not_json: 'checkpoint must contain JSON',
  cycle: 'checkpoint must not contain cycles',
  not_plain: 'checkpoint must contain plain JSON objects',
  array_extra_keys: 'checkpoint array is sparse or has extra properties',
  sparse_array: 'checkpoint array is sparse',
};

export function assertBoundedCheckpointJson(value: unknown): void {
  const measured = measureBoundedJson(value, WORKFLOW_CHECKPOINT_LIMITS);
  if (!measured.ok)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      CHECKPOINT_JSON_REFUSALS[measured.refusal],
    );
}

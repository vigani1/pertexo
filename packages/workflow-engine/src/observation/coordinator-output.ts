import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  inspectJsonValue,
} from '@pertexo/workflow-model';
import type { JsonValue } from '@pertexo/workflow-model';

import { normalizeBoundedEngineJson } from '../compilation/executable.validation.js';
import { isJsonRecord, operationError } from '../operation-values.js';
import { UUID_PATTERN } from '@pertexo/workflow-model';
import type { OutputReference } from '../workflow-execution.js';

// At most the graph's concurrent invocations can complete between advances.
// Each identity carries a 256-character key (at most six JSON bytes per
// character), UUID, sequence and fixed field punctuation.
const maximumMaterialIdentityBytes =
  JSON.stringify({
    sequence: 2_147_483_647,
    attemptId: '0'.repeat(36),
    invocationKey: String.fromCharCode(0).repeat(
      WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength,
    ),
    value: null,
  }).length - 'null'.length;
const COORDINATOR_COMPLETION_OUTPUT_LIMITS = Object.freeze({
  bytes:
    STORED_EXECUTION_VALUE_LIMITS.inlineBytes + maximumMaterialIdentityBytes,
  depth: STORED_EXECUTION_VALUE_LIMITS.depth + 2,
  members: STORED_EXECUTION_VALUE_LIMITS.members + 4,
});
export const COORDINATOR_COMPLETION_WINDOW_LIMITS = Object.freeze({
  count: WORKFLOW_GRAPH_CONTRACT_LIMITS.maxConcurrentInvocations,
  bytes:
    WORKFLOW_GRAPH_CONTRACT_LIMITS.maxConcurrentInvocations *
      (COORDINATOR_COMPLETION_OUTPUT_LIMITS.bytes + 1) +
    2,
  depth: COORDINATOR_COMPLETION_OUTPUT_LIMITS.depth,
  members:
    WORKFLOW_GRAPH_CONTRACT_LIMITS.maxConcurrentInvocations *
    (COORDINATOR_COMPLETION_OUTPUT_LIMITS.members + 1),
});

export function completedOutputReference(
  outcome: Readonly<Record<string, JsonValue>>,
  attemptId: string,
): Exclude<OutputReference, { kind: 'call' | 'reused' | 'task' }> | undefined {
  const output = outcome.output;
  if (!isJsonRecord(output)) return undefined;
  const { artifactId } = output;
  if (output.kind === 'inline' && output.attemptId === attemptId)
    return { kind: 'inline', attemptId };
  const validArtifactReference =
    output.kind === 'artifact' &&
    typeof artifactId === 'string' &&
    UUID_PATTERN.test(artifactId);
  if (validArtifactReference)
    return { kind: 'artifact', artifactId: artifactId };
  return undefined;
}

export function parseCompletedOutputItems(
  value: unknown,
): readonly JsonValue[] {
  const entries = value ?? [];
  if (!Array.isArray(entries))
    operationError(
      'observation_invalid',
      'Completed control outputs must be an array.',
    );
  if (entries.length > COORDINATOR_COMPLETION_WINDOW_LIMITS.count)
    operationError(
      'observation_invalid',
      `Completed control output window exceeds ${String(COORDINATOR_COMPLETION_WINDOW_LIMITS.count)} outputs.`,
    );
  let normalized: JsonValue;
  try {
    normalized = normalizeBoundedEngineJson(
      entries,
      COORDINATOR_COMPLETION_WINDOW_LIMITS,
    );
  } catch {
    operationError(
      'observation_invalid',
      'Completed control output window exceeds the bounded JSON limits.',
    );
  }
  if (!Array.isArray(normalized))
    operationError('observation_invalid', 'completed outputs must be an array');
  for (const item of normalized) {
    const size = inspectJsonValue(item);
    const limits = COORDINATOR_COMPLETION_OUTPUT_LIMITS;
    if (
      size.bytes > limits.bytes ||
      size.members > limits.members ||
      size.depth + 1 > limits.depth
    )
      operationError(
        'observation_invalid',
        'A completed control output exceeds the stored inline-output limits. Reduce the step output.',
      );
  }
  return normalized as readonly JsonValue[];
}

export function indexPersistedSuccessfulOutcomes(
  persistedItems: readonly JsonValue[],
): ReadonlyMap<string, Readonly<Record<string, JsonValue>>> {
  const outcomes = new Map<string, Readonly<Record<string, JsonValue>>>();
  for (const candidate of persistedItems) {
    const successfulOutcome =
      isJsonRecord(candidate) &&
      candidate.kind === 'outcome' &&
      candidate.status === 'succeeded';
    if (successfulOutcome) {
      const outcome = candidate as Readonly<{
        sequence: number;
        attemptId: string;
        invocationKey: string;
      }> &
        Readonly<Record<string, JsonValue>>;
      outcomes.set(
        `${String(outcome.sequence)}\u0000${outcome.attemptId}\u0000${outcome.invocationKey}`,
        outcome,
      );
    }
  }
  return outcomes;
}

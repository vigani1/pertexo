import type { JsonValue } from '@pertexo/workflow-model';

import { normalizeBoundedEngineJson } from '../compilation/validation.js';
import { isJsonRecord, operationError } from '../operation-values.js';
import { UUID_PATTERN } from '@pertexo/workflow-model';
import type { OutputReference } from '../types.js';

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
  let normalized: JsonValue;
  try {
    normalized = normalizeBoundedEngineJson(value ?? []);
  } catch {
    operationError('observation_invalid', 'completed outputs are invalid');
  }
  if (!Array.isArray(normalized))
    operationError('observation_invalid', 'completed outputs must be an array');
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

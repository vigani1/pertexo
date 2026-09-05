import type { JsonValue } from '@pertexo/workflow-model/canonical-json';

import { normalizeBoundedEngineJson } from './executable-workflow.js';
import { isJsonRecord, operationError } from './operation-values.js';
import { uuidPattern } from './persisted-observations.js';
import type { OutputReference } from './types.js';

export function completedOutputReference(
  outcome: Readonly<Record<string, JsonValue>>,
  attemptId: string,
): OutputReference | undefined {
  const output = outcome.output;
  if (!isJsonRecord(output)) return undefined;
  if (output.kind === 'inline' && output.attemptId === attemptId)
    return { kind: 'inline', attemptId };
  if (
    output.kind === 'artifact' &&
    typeof output.artifactId === 'string' &&
    uuidPattern.test(output.artifactId)
  )
    return { kind: 'artifact', artifactId: output.artifactId };
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
    if (
      isJsonRecord(candidate) &&
      candidate.kind === 'outcome' &&
      candidate.status === 'succeeded'
    ) {
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

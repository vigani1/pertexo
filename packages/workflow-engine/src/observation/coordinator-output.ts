import type { JsonValue } from '@pertexo/workflow-model/canonical-json';

import { normalizeBoundedEngineJson } from '../executable-workflow.js';
import { isJsonRecord, operationError } from '../operation-values.js';
import { uuidPattern } from './persisted-observations.js';
import type { AttemptOutputReference } from '../types.js';
import { ownCompletedFields } from '../completed-output-fields.js';

/** V3 keeps the existing fact metadata budget separate from each source value. */
export function parseCompletedOutputItemsV3(
  value: unknown,
): readonly JsonValue[] {
  try {
    const source = value ?? [];
    const fields = ownCompletedFields(source, 'observation_invalid');
    if (!Array.isArray(source))
      operationError(
        'observation_invalid',
        'completed outputs must be an array',
      );
    const descriptors = Object.values(fields).map((candidate) => {
      if (Array.isArray(candidate))
        operationError(
          'observation_invalid',
          'completed output must be an object',
        );
      const descriptor = ownCompletedFields(candidate, 'observation_invalid');
      if (
        Object.keys(descriptor).length !== 4 ||
        !['sequence', 'attemptId', 'invocationKey', 'value'].every((key) =>
          Object.hasOwn(descriptor, key),
        )
      )
        operationError('observation_invalid', 'observation fields are invalid');
      return descriptor;
    });
    const metadata = normalizeBoundedEngineJson(
      descriptors.map(({ sequence, attemptId, invocationKey }) => ({
        sequence,
        attemptId,
        invocationKey,
      })),
    );
    if (!Array.isArray(metadata))
      operationError(
        'observation_invalid',
        'completed output metadata is invalid',
      );
    for (const item of metadata) {
      if (
        !isJsonRecord(item) ||
        typeof item.sequence !== 'number' ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence < 1 ||
        typeof item.attemptId !== 'string' ||
        !uuidPattern.test(item.attemptId) ||
        typeof item.invocationKey !== 'string'
      )
        operationError(
          'observation_invalid',
          'completed output identity is invalid',
        );
    }
    return descriptors.map((descriptor, index) => ({
      ...(metadata[index] as Readonly<Record<string, JsonValue>>),
      value: normalizeBoundedEngineJson(descriptor.value),
    }));
  } catch {
    operationError('observation_invalid', 'completed outputs are invalid');
  }
}

export function completedOutputReference(
  outcome: Readonly<Record<string, JsonValue>>,
  attemptId: string,
): AttemptOutputReference | undefined {
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

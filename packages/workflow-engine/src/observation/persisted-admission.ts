import {
  type JsonValue,
  utf8ByteLength,
  WORKFLOW_OBSERVATION_WINDOW_LIMITS,
} from '@pertexo/workflow-model';

import { normalizeBoundedEngineJson } from '../compilation/validation.js';
import { operationError } from '../operation-values.js';

/** Facts come from our own PostgreSQL rows: JSON, so only its shape needs checking. */
function admitObservationArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value))
    operationError('observation_invalid', 'observations must be an array');
  if (value.length > WORKFLOW_OBSERVATION_WINDOW_LIMITS.facts)
    operationError('observation_invalid', 'observation window is too large');
  return value as readonly unknown[];
}

function normalizeObservationFact(item: unknown): Readonly<{
  bytes: number;
  value: JsonValue;
}> {
  let value: JsonValue;
  try {
    value = normalizeBoundedEngineJson(item);
  } catch {
    operationError('observation_invalid', 'observations are invalid');
  }
  const bytes = utf8ByteLength(JSON.stringify(value));
  if (bytes > WORKFLOW_OBSERVATION_WINDOW_LIMITS.canonicalFactBytes)
    operationError('observation_invalid', 'observation fact is too large');
  return { bytes, value };
}

export function normalizePersistedObservationWindow(
  value: unknown,
): readonly JsonValue[] {
  const entries = admitObservationArray(value);
  let canonicalBytes = 0;
  const normalizedEntries: JsonValue[] = [];
  for (const item of entries) {
    const normalized = normalizeObservationFact(item);
    canonicalBytes += normalized.bytes;
    if (
      canonicalBytes > WORKFLOW_OBSERVATION_WINDOW_LIMITS.canonicalWindowBytes
    )
      operationError('observation_invalid', 'observation window is too large');
    normalizedEntries.push(normalized.value);
  }
  return normalizedEntries;
}

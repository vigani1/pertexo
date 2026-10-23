import { types as nodeTypes } from 'node:util';
import {
  type JsonValue,
  utf8ByteLength,
  WORKFLOW_OBSERVATION_WINDOW_LIMITS,
} from '@pertexo/workflow-model';

import { normalizeBoundedEngineJson } from '../compilation/validation.js';
import { operationError } from '../operation-values.js';

function admitObservationArray(value: unknown): readonly unknown[] {
  const { admittedArray, admittedLength } =
    admittedObservationArrayLength(value);
  if (admittedArray === undefined || admittedLength === undefined)
    operationError('observation_invalid', 'observations must be an array');
  if (admittedLength > WORKFLOW_OBSERVATION_WINDOW_LIMITS.facts)
    operationError('observation_invalid', 'observation window is too large');

  try {
    const names = Object.getOwnPropertyNames(admittedArray);
    const hasExactNames =
      Object.getOwnPropertySymbols(admittedArray).length === 0 &&
      names.length === admittedLength + 1 &&
      names.includes('length');
    if (hasExactNames) {
      const admitted: unknown[] = [];
      for (let index = 0; index < admittedLength; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          admittedArray,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        )
          break;
        admitted.push(descriptor.value);
      }
      if (admitted.length === admittedLength) return admitted;
    }
  } catch {
    // The stable operation error below owns all hostile reflection failures.
  }
  return operationError('observation_invalid', 'observations are invalid');
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

function admittedObservationArrayLength(value: unknown) {
  let admittedArray: unknown[] | undefined;
  let admittedLength: number | undefined;
  try {
    if (!nodeTypes.isProxy(value) && Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        Object.getPrototypeOf(value) === Array.prototype &&
        lengthDescriptor !== undefined &&
        'value' in lengthDescriptor &&
        Number.isSafeInteger(lengthDescriptor.value) &&
        lengthDescriptor.value >= 0
      ) {
        admittedArray = value;
        admittedLength = lengthDescriptor.value as number;
      }
    }
  } catch {
    // The stable operation error below owns all hostile reflection failures.
  }
  return { admittedArray, admittedLength };
}

import { utf8ByteLength } from '@pertexo/workflow-model';
import { UUID_PATTERN } from '@pertexo/workflow-model';

import { WORKFLOW_OBSERVATION_WINDOW_LIMITS } from '@pertexo/workflow-model';
import { CoordinatorRunStateCorruptError } from '../contract.js';
import { serializeStoredExecutionJsonValue } from '../../../platform/stored-execution-value.js';

const maximumCanonicalEventPayloadBytes =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS.canonicalFactBytes;

function normalizedJson(value: unknown): unknown {
  try {
    return JSON.parse(serializeStoredExecutionJsonValue(value)) as unknown;
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  const normalized = normalizedJson(value);
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    throw new CoordinatorRunStateCorruptError();
  return normalized as Readonly<Record<string, unknown>>;
}

export function canonicalEventPayload(value: unknown): Readonly<{
  bytes: number;
  payload: Readonly<Record<string, unknown>>;
}> {
  let serialized: string;
  try {
    serialized = serializeStoredExecutionJsonValue(value);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  const bytes = utf8ByteLength(serialized);
  if (bytes > maximumCanonicalEventPayloadBytes)
    throw new CoordinatorRunStateCorruptError();
  const normalized = JSON.parse(serialized) as unknown;
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    throw new CoordinatorRunStateCorruptError();
  return Object.freeze({
    bytes,
    payload: normalized as Readonly<Record<string, unknown>>,
  });
}

export function eventPayloadRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return canonicalEventPayload(value).payload;
}

export function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new CoordinatorRunStateCorruptError();
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    throw new CoordinatorRunStateCorruptError();
  return value;
}

export function eventIdentity(
  payload: Readonly<Record<string, unknown>>,
): Readonly<{
  attemptId: string;
  nodeRunId: string;
}> {
  if (
    typeof payload.attemptId !== 'string' ||
    !UUID_PATTERN.test(payload.attemptId) ||
    typeof payload.nodeRunId !== 'string' ||
    !UUID_PATTERN.test(payload.nodeRunId)
  )
    throw new CoordinatorRunStateCorruptError();
  return { attemptId: payload.attemptId, nodeRunId: payload.nodeRunId };
}

import { utf8ByteLength } from '@pertexo/workflow-model';
import { UUID_PATTERN } from '@pertexo/workflow-model';
import { WORKFLOW_OBSERVATION_WINDOW_LIMITS } from '@pertexo/workflow-model';
import { CoordinatorRunStateCorruptError } from '../../state-errors.js';
import { serializeStoredExecutionJsonValue } from '@pertexo/database/primitives';

const maximumCanonicalEventPayloadBytes =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS.canonicalFactBytes;

function normalizedJson(value: unknown): unknown {
  try {
    return JSON.parse(serializeStoredExecutionJsonValue(value));
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  const normalized = normalizedJson(value);
  if (!isRecord(normalized)) throw new CoordinatorRunStateCorruptError();
  return normalized;
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
  const normalized: unknown = JSON.parse(serialized);
  if (!isRecord(normalized)) throw new CoordinatorRunStateCorruptError();
  return Object.freeze({
    bytes,
    payload: normalized,
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
  const { attemptId, nodeRunId } = payload;
  const invalidAttemptIdentity =
    typeof attemptId !== 'string' ||
    !UUID_PATTERN.test(attemptId) ||
    typeof nodeRunId !== 'string' ||
    !UUID_PATTERN.test(nodeRunId);
  if (invalidAttemptIdentity) throw new CoordinatorRunStateCorruptError();
  return { attemptId, nodeRunId };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

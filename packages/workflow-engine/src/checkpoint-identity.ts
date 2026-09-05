import { WorkflowEngineError } from './errors.js';

const engineVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function invalid(message: string): never {
  throw new WorkflowEngineError('checkpoint_invalid', message);
}

export function assertPersistedEngineVersion(value: unknown): string {
  if (typeof value !== 'string' || !engineVersionPattern.test(value))
    invalid('engineVersion is invalid');
  return value;
}

export function assertPersistedWorkflowVersionId(value: unknown): string {
  if (typeof value !== 'string' || !canonicalUuidPattern.test(value))
    invalid('workflowVersionId is invalid');
  return value;
}

export function assertCanonicalTimestamp(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    !canonicalTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid(`${label} must be a canonical UTC timestamp`);
  return value;
}

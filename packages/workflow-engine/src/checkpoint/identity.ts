import { UUID_PATTERN } from '@pertexo/workflow-model';
import { WorkflowEngineError } from '../errors.js';

const engineVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
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
  if (typeof value !== 'string' || !UUID_PATTERN.test(value))
    invalid('workflowVersionId is invalid');
  return value;
}

export function assertCanonicalTimestamp(
  value: unknown,
  label: string,
): string {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  const expected =
    typeof value === 'string' && !value.includes('.')
      ? value.replace(/Z$/u, '.000Z')
      : value;
  if (
    typeof value !== 'string' ||
    !canonicalTimestampPattern.test(value) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== expected
  )
    invalid(`${label} must be a canonical UTC timestamp`);
  return value;
}

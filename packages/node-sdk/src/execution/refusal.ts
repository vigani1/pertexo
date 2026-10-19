import { z } from 'zod';

import {
  NodeConfigValidationError,
  NodeInputValidationError,
} from './errors.js';

const REASON_MAX_LENGTH = 512;

/**
 * Why a step refused its input or setup, in words safe to show whoever built
 * it: the sentence the step wrote, or the first schema issue and where it
 * sits. Every other failure has no step-authored reason.
 */
export function describeNodeRefusal(error: unknown): string | undefined {
  if (
    !(error instanceof NodeInputValidationError) &&
    !(error instanceof NodeConfigValidationError)
  )
    return undefined;
  const cause: unknown = error.cause;
  if (typeof cause === 'string') return bounded(cause);
  if (!(cause instanceof z.ZodError)) return undefined;
  const [first, ...rest] = cause.issues;
  if (first === undefined) return undefined;
  const part = error instanceof NodeInputValidationError ? 'Input' : 'Setting';
  const where = issuePath(first.path);
  return bounded(
    `${part}${where === '' ? '' : ` ${where}`}: ${first.message}${
      rest.length === 0 ? '' : ` (and ${String(rest.length)} more)`
    }`,
  );
}

function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) =>
      typeof segment === 'number'
        ? `[${String(segment)}]`
        : `${index === 0 ? '' : '.'}${String(segment)}`,
    )
    .join('');
}

function bounded(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed === '') return undefined;
  return trimmed.length <= REASON_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, REASON_MAX_LENGTH - 1)}…`;
}

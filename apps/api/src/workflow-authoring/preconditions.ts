const strongDraftTagPattern = /^"draft-v1\.[A-Za-z0-9_-]{43}"$/u;
const printableHeaderPattern = /^[\x21-\x7e]+$/u;

export class PreconditionRequiredError extends Error {
  public override readonly name = 'PreconditionRequiredError';
  public constructor() {
    super('If-Match is required');
  }
}

export class InvalidWorkflowHeaderError extends Error {
  public override readonly name = 'InvalidWorkflowHeaderError';
  public constructor(header: 'If-Match' | 'Idempotency-Key') {
    super(`${header} must contain exactly one valid value`);
  }
}

function oneHeaderValue(
  value: unknown,
  header: 'If-Match' | 'Idempotency-Key',
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (Array.isArray(value) && value.length === 1) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  throw new InvalidWorkflowHeaderError(header);
}

/** Parse one strong validator; list, wildcard, weak, and malformed values fail closed. */
export function parseStrongIfMatch(value: unknown): string {
  const candidate = oneHeaderValue(value, 'If-Match');
  if (candidate === undefined) throw new PreconditionRequiredError();
  if (!strongDraftTagPattern.test(candidate))
    throw new InvalidWorkflowHeaderError('If-Match');
  return candidate;
}

/** Parse the single idempotency key accepted by command endpoints. */
export function parseIdempotencyKey(value: unknown): string {
  const candidate = oneHeaderValue(value, 'Idempotency-Key');
  if (
    candidate === undefined ||
    candidate.length < 1 ||
    candidate.length > 128 ||
    candidate.includes(',') ||
    !printableHeaderPattern.test(candidate)
  )
    throw new InvalidWorkflowHeaderError('Idempotency-Key');
  return candidate;
}

export type HeaderValue = string | readonly string[] | undefined;

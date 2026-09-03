const strongDraftTagPattern = /^"draft-v1\.[A-Za-z0-9_-]{43}"$/u;
const printableHeaderPattern = /^[\x21-\x7e]+$/u;

export class WorkflowHeaderError extends Error {
  public override readonly name = 'WorkflowHeaderError';
  public constructor(
    public readonly code: 'invalid' | 'precondition_required',
    header: 'If-Match' | 'Idempotency-Key',
  ) {
    super(
      code === 'precondition_required'
        ? `${header} is required`
        : `${header} must contain exactly one valid value`,
    );
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
  throw new WorkflowHeaderError('invalid', header);
}

/** Parse one strong validator; list, wildcard, weak, and malformed values fail closed. */
export function parseStrongIfMatch(value: unknown): string {
  const candidate = oneHeaderValue(value, 'If-Match');
  if (candidate === undefined)
    throw new WorkflowHeaderError('precondition_required', 'If-Match');
  if (!strongDraftTagPattern.test(candidate))
    throw new WorkflowHeaderError('invalid', 'If-Match');
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
    throw new WorkflowHeaderError('invalid', 'Idempotency-Key');
  return candidate;
}

export type HeaderValue = string | readonly string[] | undefined;

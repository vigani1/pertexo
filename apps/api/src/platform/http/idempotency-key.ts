const printableHeaderPattern = /^[\x21-\x7e]+$/u;

export class InvalidIdempotencyKeyError extends Error {
  public override readonly name = 'InvalidIdempotencyKeyError';
  public constructor() {
    super('Idempotency-Key must contain exactly one valid value');
  }
}

/** Parse the single printable idempotency key accepted by command endpoints. */
export function parseIdempotencyKey(value: unknown): string {
  const candidate = oneHeaderValue(value);
  if (
    candidate === undefined ||
    candidate.length < 1 ||
    candidate.length > 128 ||
    candidate.includes(',') ||
    !printableHeaderPattern.test(candidate)
  )
    throw new InvalidIdempotencyKeyError();
  return candidate;
}

function oneHeaderValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (Array.isArray(value) && value.length === 1) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  throw new InvalidIdempotencyKeyError();
}

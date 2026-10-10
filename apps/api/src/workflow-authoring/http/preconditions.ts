const strongDraftTagPattern = /^"draft\.[A-Za-z0-9_-]{43}"$/u;

export class WorkflowHeaderError extends Error {
  public override readonly name = 'WorkflowHeaderError';
  public constructor(
    public readonly code: 'invalid' | 'precondition_required',
  ) {
    super(
      code === 'precondition_required'
        ? 'If-Match is required'
        : 'If-Match must contain exactly one valid value',
    );
  }
}

function oneHeaderValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (Array.isArray(value) && value.length === 1) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  throw new WorkflowHeaderError('invalid');
}

/** Parse one strong validator; list, wildcard, weak, and malformed values fail closed. */
export function parseStrongIfMatch(value: unknown): string {
  const candidate = oneHeaderValue(value);
  if (candidate === undefined)
    throw new WorkflowHeaderError('precondition_required');
  if (!strongDraftTagPattern.test(candidate))
    throw new WorkflowHeaderError('invalid');
  return candidate;
}

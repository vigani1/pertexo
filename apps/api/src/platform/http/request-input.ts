import { z } from 'zod';

// Input that failed its schema. Unlike any other parse failure (a stored row,
// a response), its issues describe only what the caller sent.
const requestInputErrors = new WeakSet<object>();

/** Parses a body or query; on failure the ZodError is marked as the caller's. */
export function parseRequestInput<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  requestInputErrors.add(parsed.error);
  throw parsed.error;
}

/** Whether this failure is the caller's input, so its issues may go back. */
export function isRequestInputError(error: unknown): error is z.ZodError {
  return (
    typeof error === 'object' && error !== null && requestInputErrors.has(error)
  );
}

/** Input's own issues go back to its caller; other parse failures stay private. */
export function requestInputCause(
  error: unknown,
): Readonly<{ cause?: unknown }> {
  return isRequestInputError(error) ? { cause: error } : {};
}

/** A field policy refusal belongs to caller input just as a failed shape does. */
export function requestInputError(
  path: readonly PropertyKey[],
  message: string,
): z.ZodError {
  const error = new z.ZodError([{ code: 'custom', path: [...path], message }]);
  requestInputErrors.add(error);
  return error;
}

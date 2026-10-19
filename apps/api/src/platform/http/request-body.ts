import type { z } from 'zod';

// Bodies that failed their schema. Unlike any other parse failure (a stored
// row, a response), their issues describe only what the caller sent.
const requestBodyErrors = new WeakSet<object>();

/** Parses a request body; on failure the ZodError is marked as the caller's. */
export function parseRequestBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  requestBodyErrors.add(parsed.error);
  throw parsed.error;
}

/** Whether this failure is a request body's, so its issues may go back. */
export function isRequestBodyError(error: unknown): error is z.ZodError {
  return (
    typeof error === 'object' && error !== null && requestBodyErrors.has(error)
  );
}

/** A body's own issues go back to its caller; other parse failures stay private. */
export function requestBodyCause(
  error: unknown,
): Readonly<{ cause?: unknown }> {
  return isRequestBodyError(error) ? { cause: error } : {};
}

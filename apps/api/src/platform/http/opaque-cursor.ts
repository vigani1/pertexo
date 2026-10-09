import type { z } from 'zod';

const MAX_CURSOR_LENGTH = 1_024;

/**
 * An opaque keyset position: base64url JSON of a payload only its schema
 * reads. A cursor never authorizes anything; each reader checks that the
 * cursor belongs to its query.
 */
export function encodeOpaqueCursor<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): string {
  return Buffer.from(JSON.stringify(schema.parse(payload)), 'utf8').toString(
    'base64url',
  );
}

/** The cursor's payload, or undefined when it is not one of this schema. */
export function decodeOpaqueCursor<T>(
  schema: z.ZodType<T>,
  value: string,
): T | undefined {
  if (value.length > MAX_CURSOR_LENGTH) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

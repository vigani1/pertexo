import { z } from 'zod';

// W3C trace context, version 00: `00-<trace id>-<parent id>-<flags>` in
// lowercase hex. An all-zero trace id or parent id is invalid.
const TRACEPARENT =
  /^00-(?<traceId>(?!0{32})[\da-f]{32})-(?!0{16})[\da-f]{16}-[\da-f]{2}$/u;

/** The trace id a valid traceparent carries, or undefined for any other text. */
export function traceIdOf(traceparent: string): string | undefined {
  return TRACEPARENT.exec(traceparent)?.groups?.traceId;
}

/** A W3C version 00 traceparent header, as the API, queue and core accept it. */
export const traceparentSchema = z
  .string()
  .regex(
    TRACEPARENT,
    'traceparent must be a W3C version 00 header with non-zero ids',
  );

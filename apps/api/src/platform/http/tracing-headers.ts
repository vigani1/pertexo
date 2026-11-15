import { z } from 'zod';
import { singleRequestHeader, type RequestHeaders } from './request-headers.js';
import { parseRequestInput } from './request-input.js';

const traceparentSchema = z
  .string()
  // Version 00; an all-zero trace or span id is invalid.
  .regex(/^00-(?!0{32})[\da-f]{32}-(?!0{16})[\da-f]{16}-[\da-f]{2}$/u);

export function traceparent(
  request: Readonly<{ headers?: RequestHeaders }>,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined
    ? {}
    : { traceparent: parseRequestInput(traceparentSchema, value) };
}

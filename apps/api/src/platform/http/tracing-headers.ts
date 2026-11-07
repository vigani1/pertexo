import { z } from 'zod';
import { singleRequestHeader, type RequestHeaders } from './request-headers.js';
import { parseRequestInput } from './request-input.js';

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));

export function traceparent(
  request: Readonly<{ headers?: RequestHeaders }>,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined
    ? {}
    : { traceparent: parseRequestInput(traceparentSchema, value) };
}

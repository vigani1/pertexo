import { traceparentSchema } from '@pertexo/workflow-model';
import { singleRequestHeader, type RequestHeaders } from './request-headers.js';
import { parseRequestInput } from './request-input.js';

export function traceparent(
  request: Readonly<{ headers?: RequestHeaders }>,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined
    ? {}
    : { traceparent: parseRequestInput(traceparentSchema, value) };
}

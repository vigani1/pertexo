import { describe, expect, it } from 'vitest';

import {
  traceIdOf,
  traceparentSchema,
} from '../../src/execution/traceparent.js';

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const parentId = '00f067aa0ba902b7';
const valid = `00-${traceId}-${parentId}-01`;

describe('the traceparent format', () => {
  it('accepts a version 00 header and reads its trace id', () => {
    expect(traceparentSchema.safeParse(valid).success).toBe(true);
    expect(traceIdOf(valid)).toBe(traceId);
  });

  it.each([
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${parentId}-01`],
    ['an all-zero parent id', `00-${traceId}-${'0'.repeat(16)}-01`],
    ['another version', `01-${traceId}-${parentId}-01`],
    ['uppercase hex', `00-${traceId.toUpperCase()}-${parentId}-01`],
    ['a short trace id', `00-${traceId.slice(1)}-${parentId}-01`],
    ['a long parent id', `00-${traceId}-${parentId}0-01`],
    ['a missing flags field', `00-${traceId}-${parentId}`],
    ['trailing text', `${valid}-extra`],
    ['an empty header', ''],
  ])('refuses %s', (_case, header) => {
    expect(traceparentSchema.safeParse(header).success).toBe(false);
    expect(traceIdOf(header)).toBeUndefined();
  });
});

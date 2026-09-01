import { describe, expect, it } from 'vitest';

import {
  firstRequestHeader,
  requestHeaderValue,
  singleRequestHeader,
} from '../../src/platform/http/request-headers.js';

describe('HTTP request-header policies', () => {
  const headers = {
    'X-Scalar': 'scalar',
    'X-Values': ['first', 'second'],
    'X-Single': ['only'],
  } as const;

  it('finds raw values case-insensitively', () => {
    expect(requestHeaderValue(headers, 'x-scalar')).toBe('scalar');
    expect(requestHeaderValue(headers, 'x-values')).toEqual([
      'first',
      'second',
    ]);
  });

  it('makes the first-value policy explicit', () => {
    expect(firstRequestHeader(headers, 'X-VALUES')).toBe('first');
  });

  it('makes the strict-single-value policy explicit', () => {
    expect(singleRequestHeader(headers, 'x-single')).toBe('only');
    expect(singleRequestHeader(headers, 'x-values')).toBeUndefined();
  });
});

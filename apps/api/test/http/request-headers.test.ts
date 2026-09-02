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
    expect(requestHeaderValue(undefined, 'x-scalar')).toBeUndefined();
    expect(requestHeaderValue(headers, 'x-missing')).toBeUndefined();
  });

  it('makes the first-value policy explicit', () => {
    expect(firstRequestHeader(headers, 'X-VALUES')).toBe('first');
    expect(firstRequestHeader(headers, 'x-missing')).toBeUndefined();
  });

  it('makes the strict-single-value policy explicit', () => {
    expect(singleRequestHeader(headers, 'x-single')).toBe('only');
    expect(singleRequestHeader(headers, 'x-values')).toBeUndefined();
    expect(
      singleRequestHeader(
        { 'x-invalid': [42] as unknown as readonly string[] },
        'x-invalid',
      ),
    ).toBeUndefined();
  });
});

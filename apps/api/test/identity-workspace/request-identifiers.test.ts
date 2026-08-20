import { describe, expect, it } from 'vitest';

import {
  requestIdentifier,
  traceIdentifier,
} from '../../src/identity-workspace/index.js';

describe('identity/workspace request identifiers', () => {
  it('prefers the validated middleware request id over a caller header', () => {
    expect(
      requestIdentifier({
        requestId: 'middleware-request-42',
        headers: { 'x-request-id': 'caller-request-42' },
      }),
    ).toBe('middleware-request-42');
  });

  it('extracts a bounded trace id from traceparent without storing the full header', () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    const traceparent = `00-${traceId}-0123456789abcdef-01`;

    expect(traceIdentifier({ headers: { traceparent } })).toBe(traceId);
    expect(traceIdentifier({ traceId: traceparent })).toBe(traceId);
  });
});

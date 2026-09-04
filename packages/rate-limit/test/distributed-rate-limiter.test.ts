import { describe, expect, it } from 'vitest';

import {
  DistributedRateLimiter,
  type RateLimitDecision,
  type RateLimitScriptExecutor,
} from '../src/index.js';

const decision: RateLimitDecision = {
  endpointClass: 'provider_test',
  failureMode: 'closed',
  windowSeconds: 60,
  dimensions: [
    { kind: 'actor', identifier: 'actor-secret', limit: 10 },
    { kind: 'workspace', identifier: 'workspace-secret', limit: 20 },
    { kind: 'connection', identifier: 'connection-secret', limit: 5 },
  ],
};

class FakeExecutor implements RateLimitScriptExecutor {
  readonly calls: unknown[][] = [];

  constructor(private readonly result: unknown) {}

  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: string[]
  ): Promise<unknown> {
    this.calls.push([script, numberOfKeys, ...arguments_]);
    return Promise.resolve(this.result);
  }
}

describe('distributed abuse rate limiter', () => {
  it('uses one atomic script and never sends raw subject identifiers as keys', async () => {
    const executor = new FakeExecutor([1, 0, 0]);
    const limiter = new DistributedRateLimiter(executor);

    await expect(limiter.consume(decision)).resolves.toEqual({ allowed: true });

    expect(executor.calls).toHaveLength(1);
    const [script, keyCount, ...arguments_] = executor.calls[0] ?? [];
    expect(script).toEqual(expect.stringContaining('redis.call'));
    expect(keyCount).toBe(3);
    expect(arguments_.slice(0, 3)).toHaveLength(3);
    expect(arguments_.slice(0, 3)).toEqual([
      expect.stringMatching(/^pertexo:abuse:v1:provider_test:actor:/u),
      expect.stringMatching(/^pertexo:abuse:v1:provider_test:workspace:/u),
      expect.stringMatching(/^pertexo:abuse:v1:provider_test:connection:/u),
    ]);
    expect(arguments_.slice(0, 3).join(':')).not.toContain('secret');
    expect(arguments_.slice(3)).toEqual(['60000', '10', '20', '5']);
  });

  it('returns a bounded retry and the rejected dimension', async () => {
    const limiter = new DistributedRateLimiter(
      new FakeExecutor([0, 120_001, 2]),
    );

    await expect(limiter.consume(decision)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
      limitedDimension: 'workspace',
    });
  });

  it('rejects malformed script results instead of silently allowing work', async () => {
    const limiter = new DistributedRateLimiter(new FakeExecutor(['yes']));

    await expect(limiter.consume(decision)).rejects.toThrow(
      'Invalid rate-limit script result',
    );
  });

  it.each([
    ['zero window', { ...decision, windowSeconds: 0 }],
    ['fractional window', { ...decision, windowSeconds: 1.5 }],
    [
      'blank identifier',
      {
        ...decision,
        dimensions: [{ kind: 'actor' as const, identifier: ' ', limit: 1 }],
      },
    ],
    [
      'zero limit',
      {
        ...decision,
        dimensions: [{ kind: 'actor' as const, identifier: 'actor', limit: 0 }],
      },
    ],
    [
      'duplicate dimension',
      {
        ...decision,
        dimensions: [
          { kind: 'actor' as const, identifier: 'actor', limit: 1 },
          { kind: 'actor' as const, identifier: 'actor', limit: 1 },
        ],
      },
    ],
  ])('rejects invalid decision input: %s', async (_name, invalid) => {
    const executor = new FakeExecutor([1, 0, 0]);
    await expect(
      new DistributedRateLimiter(executor).consume(invalid),
    ).rejects.toThrow(/rate-limit decision/iu);
    expect(executor.calls).toHaveLength(0);
  });
});

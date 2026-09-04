import { describe, expect, it } from 'vitest';

import {
  normalizeRedisEndpoint,
  type RedisEndpointErrorReason,
} from '../src/redis-endpoint.js';

class EndpointPolicyError extends Error {
  constructor(readonly reason: RedisEndpointErrorReason) {
    super(reason);
  }
}

const failure = (reason: RedisEndpointErrorReason): EndpointPolicyError =>
  new EndpointPolicyError(reason);

describe('normalizeRedisEndpoint', () => {
  it.each([
    ['redis://localhost', 'redis://localhost/'],
    [
      'rediss://redis.example.test:6380/0',
      'rediss://redis.example.test:6380/0',
    ],
    [
      'redis://user:password@localhost:6379/1',
      'redis://user:password@localhost:6379/1',
    ],
    ['REDIS://LOCALHOST:6379', 'redis://localhost:6379/'],
  ])('normalizes supported endpoint %s', (input, expected) => {
    expect(normalizeRedisEndpoint(input, failure)).toBe(expected);
  });

  it.each([
    ['', 'invalid_url'],
    ['not a URL', 'invalid_url'],
    ['http://localhost:6379', 'unsupported_endpoint'],
    ['redis:///0', 'unsupported_endpoint'],
    ['file:///tmp/redis.sock', 'unsupported_endpoint'],
  ] as const)('rejects endpoint %s as %s', (input, reason) => {
    expect(() => normalizeRedisEndpoint(input, failure)).toThrow(
      expect.objectContaining({ reason }),
    );
  });
});

import { describe, expect, it } from 'vitest';

import {
  AbuseRateLimitPolicy,
  type RateLimitSubject,
} from '../../src/platform/rate-limit/policy.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';

function subject(
  change: { [Key in keyof RateLimitSubject]?: string | undefined } = {},
): RateLimitSubject {
  return Object.fromEntries(
    Object.entries({
      clientAddress: '203.0.113.8',
      origin: 'https://app.example.test',
      actorId,
      workspaceId,
      connectionId,
      ...change,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe('abuse rate-limit policy', () => {
  const policy = new AbuseRateLimitPolicy();

  it('binds identity start to normalized origin and client address', () => {
    expect(
      policy.evaluate('identity_start', subject({ actorId: undefined })),
    ).toEqual({
      endpointClass: 'identity_start',
      failureMode: 'closed',
      windowSeconds: 60,
      dimensions: [
        { kind: 'client_address', identifier: '203.0.113.8', limit: 10 },
        {
          kind: 'origin',
          identifier: 'https://app.example.test',
          limit: 30,
        },
      ],
    });
  });

  it('applies actor, workspace, and connection limits to provider tests', () => {
    expect(policy.evaluate('provider_test', subject())).toMatchObject({
      failureMode: 'closed',
      dimensions: [
        { kind: 'actor', identifier: actorId, limit: 10 },
        { kind: 'workspace', identifier: workspaceId, limit: 20 },
        { kind: 'connection', identifier: connectionId, limit: 5 },
      ],
    });
  });

  it('fails policy evaluation when a required authoritative subject is absent', () => {
    expect(() =>
      policy.evaluate('workflow_compile', subject({ actorId: undefined })),
    ).toThrow('Rate-limit actor subject is required');
    expect(() =>
      policy.evaluate('provider_test', subject({ connectionId: undefined })),
    ).toThrow('Rate-limit connection subject is required');
  });

  it('allows safe authenticated reads to fail open while mutations fail closed', () => {
    expect(policy.evaluate('authenticated_read', subject()).failureMode).toBe(
      'open',
    );
    expect(policy.evaluate('ordinary_mutation', subject()).failureMode).toBe(
      'closed',
    );
  });
});

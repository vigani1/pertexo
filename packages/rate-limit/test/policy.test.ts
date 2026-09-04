import { describe, expect, it } from 'vitest';

import { AbuseRateLimitPolicy, type RateLimitSubject } from '../src/policy.js';

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

  it('locks every endpoint class to the reviewed one-minute policy table', () => {
    const expected = {
      identity_start: [
        'closed',
        [
          ['client_address', 10],
          ['origin', 30],
        ],
      ],
      identity_callback: [
        'closed',
        [
          ['client_address', 30],
          ['origin', 60],
        ],
      ],
      authenticated_read: [
        'open',
        [
          ['actor', 600],
          ['workspace', 1_200],
        ],
      ],
      actor_mutation: ['closed', [['actor', 120]]],
      ordinary_mutation: [
        'closed',
        [
          ['actor', 120],
          ['workspace', 300],
        ],
      ],
      workflow_compile: [
        'closed',
        [
          ['actor', 30],
          ['workspace', 60],
        ],
      ],
      run_admission: [
        'closed',
        [
          ['actor', 60],
          ['workspace', 120],
        ],
      ],
      preview_test: [
        'closed',
        [
          ['actor', 20],
          ['workspace', 40],
        ],
      ],
      connection_mutation: [
        'closed',
        [
          ['actor', 30],
          ['workspace', 60],
          ['connection', 10],
        ],
      ],
      provider_test: [
        'closed',
        [
          ['actor', 10],
          ['workspace', 20],
          ['connection', 5],
        ],
      ],
      trigger_mutation: [
        'closed',
        [
          ['actor', 60],
          ['workspace', 120],
        ],
      ],
      provider_execution: [
        'closed',
        [
          ['workspace', 300],
          ['connection', 60],
        ],
      ],
    } as const;

    expect(
      Object.fromEntries(
        Object.keys(expected).map((endpointClass) => {
          const decision = policy.evaluate(
            endpointClass as keyof typeof expected,
            subject(),
          );
          return [
            endpointClass,
            [
              decision.failureMode,
              decision.dimensions.map(({ kind, limit }) => [kind, limit]),
            ],
          ];
        }),
      ),
    ).toEqual(expected);
  });

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

  it('limits authenticated mutations that do not yet have a workspace by actor', () => {
    expect(
      policy.evaluate('actor_mutation', subject({ workspaceId: undefined })),
    ).toEqual({
      endpointClass: 'actor_mutation',
      failureMode: 'closed',
      windowSeconds: 60,
      dimensions: [{ kind: 'actor', identifier: actorId, limit: 120 }],
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

  it('omits conditional workspace and connection dimensions when not scoped', () => {
    expect(
      policy.evaluate('authenticated_read', subject({ workspaceId: undefined }))
        .dimensions,
    ).toEqual([{ kind: 'actor', identifier: actorId, limit: 600 }]);
    expect(
      policy.evaluate('ordinary_mutation', subject({ workspaceId: undefined }))
        .dimensions,
    ).toEqual([{ kind: 'actor', identifier: actorId, limit: 120 }]);
    expect(
      policy.evaluate(
        'connection_mutation',
        subject({ connectionId: undefined }),
      ).dimensions,
    ).toEqual([
      { kind: 'actor', identifier: actorId, limit: 30 },
      { kind: 'workspace', identifier: workspaceId, limit: 60 },
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  AbuseRateLimitPolicy,
  type RateLimitSubject,
} from '../src/rate-limit-policy.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';

function subject(
  change: { [Key in keyof RateLimitSubject]?: string | undefined } = {},
): RateLimitSubject {
  return Object.fromEntries(
    Object.entries({
      clientAddress: '203.0.113.8',
      account: 'someone@example.test',
      actorId,
      workspaceId,
      connectionId,
      formId: connectionId,
      ...change,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe('abuse rate-limit policy', () => {
  const policy = new AbuseRateLimitPolicy();

  it('locks every endpoint class to the reviewed one-minute policy table', () => {
    const expected = {
      webhook_preflight: ['closed', [['client_address', 60]]],
      notice_unsubscribe: ['closed', [['client_address', 30]]],
      form_read: [
        'closed',
        [
          ['client_address', 60],
          ['form', 300],
        ],
      ],
      form_submission: [
        'closed',
        [
          ['client_address', 10],
          ['form', 30],
        ],
      ],
      form_workspace_submission: ['closed', [['workspace', 60]]],
      form_upload: [
        'closed',
        [
          ['client_address', 20],
          ['form', 60],
          ['workspace', 120],
        ],
      ],
      identity_start: [
        'closed',
        [
          ['client_address', 10],
          ['account', 20],
        ],
      ],
      sign_in_page_read: ['closed', [['client_address', 1_200]]],
      federated_sign_in_start: ['closed', [['client_address', 300]]],
      federated_sign_in_callback: ['closed', [['client_address', 300]]],
      identity_callback: ['closed', [['client_address', 30]]],
      data_table_export: [
        'closed',
        [
          ['actor', 5],
          ['workspace', 10],
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
      destination_test: [
        'closed',
        [
          ['actor', 10],
          ['workspace', 20],
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

  it('fails policy evaluation when a required authoritative subject is absent', () => {
    expect(() =>
      policy.evaluate('workflow_compile', subject({ actorId: undefined })),
    ).toThrow('Rate-limit actor subject is required');
    expect(() =>
      policy.evaluate('provider_test', subject({ connectionId: undefined })),
    ).toThrow('Rate-limit connection subject is required');
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

describe('automation credential admission', () => {
  const policy = new AbuseRateLimitPolicy();
  it('protects credential lookups by client address before an actor is trusted', () => {
    const decision = policy.evaluate('automation_authentication', {
      clientAddress: '203.0.113.8',
    });
    expect(decision.failureMode).toBe('closed');
    expect(decision.dimensions).toEqual([
      { kind: 'client_address', identifier: '203.0.113.8', limit: 600 },
    ]);
  });
  it('adds token budgets while retaining shared owner and workspace budgets', () => {
    const first = policy.evaluate('run_admission', {
      actorId,
      workspaceId,
      tokenId: 'first-token',
    });
    const second = policy.evaluate('run_admission', {
      actorId,
      workspaceId,
      tokenId: 'second-token',
    });
    expect(first.dimensions).toEqual([
      { kind: 'actor', identifier: actorId, limit: 60 },
      { kind: 'workspace', identifier: workspaceId, limit: 120 },
      { kind: 'token', identifier: 'first-token', limit: 60 },
    ]);
    expect(second.dimensions.slice(0, 2)).toEqual(first.dimensions.slice(0, 2));
    expect(second.dimensions.at(-1)?.identifier).toBe('second-token');
  });
});

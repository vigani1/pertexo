import { describe, expect, it } from 'vitest';

import {
  buildAuditFact,
  createActorContext,
} from '../../src/workspaces/index.js';

const actor = createActorContext({
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  requestId: 'request-a',
  traceId: 'trace-a',
});

describe('safe workspace audit facts', () => {
  it('keeps bounded safe metadata and redacts credential-shaped fields', () => {
    const fact = buildAuditFact({
      event: 'workspace.member.role_changed',
      actor,
      target: { type: 'membership', id: 'membership-a' },
      metadata: {
        role: 'builder',
        reason: 'on-call rotation',
        token: 'oidc-token-must-not-appear',
        nested: {
          credential: 'secret',
          sessionToken: 'secret',
          safe: true,
        },
      },
    });

    expect(fact).toMatchObject({
      event: 'workspace.member.role_changed',
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      actorKind: 'user',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-a',
      traceId: 'trace-a',
      target: { type: 'membership', id: 'membership-a' },
      metadata: {
        role: 'builder',
        reason: 'on-call rotation',
        nested: { safe: true },
      },
    });
    const serialized = JSON.stringify(fact);
    expect(serialized).not.toContain('oidc-token-must-not-appear');
    expect(serialized).not.toContain('secret');
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.metadata)).toBe(true);
    expect(Object.getPrototypeOf(fact.metadata)).toBeNull();
    const nested = fact.metadata.nested;
    if (
      nested !== null &&
      typeof nested === 'object' &&
      !Array.isArray(nested)
    ) {
      expect(Object.getPrototypeOf(nested)).toBeNull();
    } else {
      throw new Error('expected nested metadata record');
    }
  });

  it('bounds metadata depth, key count, and string size', () => {
    expect(() =>
      buildAuditFact({
        event: 'workspace.updated',
        actor,
        metadata: { a: { b: { c: { d: { e: { f: true } } } } } },
      }),
    ).toThrow(/metadata/u);

    expect(() =>
      buildAuditFact({
        event: 'workspace.updated',
        actor,
        metadata: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [
            `key-${String(index)}`,
            true,
          ]),
        ),
      }),
    ).toThrow(/metadata/u);

    expect(() =>
      buildAuditFact({
        event: 'workspace.updated',
        actor,
        metadata: { reason: 'x'.repeat(1_001) },
      }),
    ).toThrow(/metadata/u);
  });

  it('does not accept credential fields in the audit actor or target', () => {
    expect(() =>
      buildAuditFact({
        event: 'identity.session.created',
        actor,
        metadata: { credentialId: 'credential-a' },
        target: { type: 'session', id: 'session-a', token: 'raw-token' },
      }),
    ).toThrow(/credential|token/u);
  });

  it('rejects prototype-shaped metadata keys without mutating object prototypes', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const metadata = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(metadata, key, {
        enumerable: true,
        value: { polluted: true },
      });

      expect(() =>
        buildAuditFact({
          event: 'workspace.updated',
          actor,
          metadata,
        }),
      ).toThrow(/prototype-shaped/u);
    }

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

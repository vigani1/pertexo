import { describe, expect, it } from 'vitest';

import { classifyConnectionTestCompletion } from '../src/connections/connection-test-persistence.js';
import {
  databaseConstraint,
  decodeDurableConnectionReplay,
} from '../src/connections/connection-persistence.js';

const secretVersionId = '11111111-1111-4111-8111-111111111111';
const outcomes = [
  {
    name: 'success',
    value: { ok: true as const, httpStatus: 204 },
    eventType: 'connection.test_succeeded',
    nextStatus: 'active',
  },
  {
    name: 'credential rejection',
    value: {
      ok: false as const,
      httpStatus: 401,
      errorCode: 'connection.credential_rejected',
      reauthorizationRequired: true,
    },
    eventType: 'connection.reauthorization_required',
    nextStatus: 'reauthorization_required',
  },
  {
    name: 'other failure',
    value: {
      ok: false as const,
      httpStatus: 503,
      errorCode: 'connection.provider_unavailable',
      reauthorizationRequired: false,
    },
    eventType: 'connection.test_failed',
    nextStatus: 'active',
  },
] as const;

describe('connection test completion classification', () => {
  it('decodes legacy pointers without accepting malformed snapshots as legacy', () => {
    expect(
      decodeDurableConnectionReplay({
        connectionId: secretVersionId,
        secretVersionId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toEqual({
      kind: 'legacy_pointer',
      connectionId: secretVersionId,
      secretVersionId: '22222222-2222-4222-8222-222222222222',
    });
    expect(() =>
      decodeDurableConnectionReplay({
        id: secretVersionId,
        workspaceId: '22222222-2222-4222-8222-222222222222',
        providerKey: 'http',
      }),
    ).toThrow();
  });

  it('inspects named database constraints without invoking hostile fields', () => {
    expect(
      databaseConstraint(
        {
          code: '23505',
          constraint: 'connections_active_name_provider_unique',
        },
        'connections_active_name_provider_unique',
      ),
    ).toBe(true);
    expect(
      databaseConstraint(
        Object.defineProperty({}, 'code', {
          get: () => {
            throw new Error('hostile getter');
          },
        }),
        'connections_active_name_provider_unique',
      ),
    ).toBe(false);
  });

  it.each([
    ['same', 'active', true, true],
    ['stale', 'active', false, false],
    ['revoked', 'revoked', true, false],
  ] as const)(
    'classifies every outcome against a %s credential',
    (_relationship, status, currentSecretWasTested, healthUpdateAllowed) => {
      for (const outcome of outcomes) {
        const result = classifyConnectionTestCompletion(
          status,
          outcome.value,
          secretVersionId,
          currentSecretWasTested,
        );
        expect(result).toMatchObject({
          eventType: outcome.eventType,
          healthUpdateAllowed,
          nextStatus:
            status === 'revoked' && outcome.name === 'other failure'
              ? 'revoked'
              : outcome.nextStatus,
        });
        expect(result.eventMetadata).toMatchObject({
          currentSecretWasTested,
          secretVersionId,
        });
      }
    },
  );
});

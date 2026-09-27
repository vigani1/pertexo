import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parsePersistedObservation } from '../src/observation/persisted-observation-parser.js';

describe('persisted executor failure code', () => {
  it.each(['provider.unavailable', 'Provider.Failure', '9Provider:Failure'])(
    'retains a writer-accepted code without normalization: %s',
    (safeErrorCode) => {
      expect(
        parsePersistedObservation({
          kind: 'attempt_failure',
          occurredAt: '2026-09-27T12:00:00.000Z',
          invocationKey: 'version/node|b:|i:',
          attemptId: randomUUID(),
          attemptNumber: 1,
          failureKind: 'retry',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode,
        }),
      ).toMatchObject({ safeErrorCode });
    },
  );
});

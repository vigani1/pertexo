import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReadinessHealthCheck } from './validate-readiness-health-check.mjs';

const contract = {
  ready: '/tmp/pertexo-worker-ready',
  notReady: '/tmp/pertexo-worker-not-ready',
};

test('worker health requires ready and rejects readiness revocation', () => {
  assert.doesNotThrow(() =>
    validateReadinessHealthCheck(
      'worker',
      [
        'CMD-SHELL',
        'test -f /tmp/pertexo-worker-ready && test ! -f /tmp/pertexo-worker-not-ready && kill -0 1',
      ],
      contract,
    ),
  );
  assert.throws(
    () =>
      validateReadinessHealthCheck(
        'worker',
        ['CMD-SHELL', 'test -f /tmp/pertexo-worker-ready && kill -0 1'],
        contract,
      ),
    /must reject its readiness-revocation marker/u,
  );
});

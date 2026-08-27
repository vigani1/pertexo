/* global Buffer */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  loadAuthentication,
  parseProfile,
  requestAuthenticationHeaders,
  responseMatchesPolicy,
} from './run-http-exercise.mjs';

const profile = {
  schemaVersion: 1,
  name: 'test-profile',
  scenario: 'steady-run-start',
  durationSeconds: 1,
  requestsPerSecond: 1,
  maxInFlight: 1,
  method: 'POST',
  authentication: 'session-cookie',
  pathEnvironment: 'PERTEXO_EXERCISE_PATH',
  bodyFileEnvironment: 'PERTEXO_EXERCISE_BODY_FILE',
  headers: { 'content-type': 'application/json' },
  responsePolicy: { expectedStatuses: [202], expectedProblemCodes: [] },
  objectives: {
    minimumAchievedRateRatio: 0.98,
    maximumServerErrorRatio: 0,
    maximumP95Milliseconds: 500,
  },
};

test('session authentication emits the product cookie and double-submit token', () => {
  const authentication = loadAuthentication('session-cookie', {
    PERTEXO_EXERCISE_SESSION_COOKIE: 'session-token-value',
    PERTEXO_EXERCISE_CSRF_TOKEN: 'csrf-token-value-1',
  });
  assert.deepEqual(requestAuthenticationHeaders(authentication, '{}'), {
    cookie:
      'pertexo_session=session-token-value; pertexo_csrf=csrf-token-value-1',
    'x-csrf-token': 'csrf-token-value-1',
  });
});

test('webhook authentication signs each raw body with its supplied timestamp', () => {
  const secret = Buffer.alloc(32, 7);
  const authentication = loadAuthentication('webhook-hmac', {
    PERTEXO_EXERCISE_WEBHOOK_SIGNING_SECRET: secret.toString('base64url'),
  });
  const headers = requestAuthenticationHeaders(
    authentication,
    '{"ok":true}',
    1_750_000_000_999,
  );
  const expected = createHmac('sha256', secret)
    .update('1750000000', 'ascii')
    .update('.')
    .update('{"ok":true}')
    .digest('hex');
  assert.deepEqual(headers, {
    'x-pertexo-signature': `v1=${expected}`,
    'x-pertexo-timestamp': '1750000000',
  });
});

test('response policy rejects authentication and unintended throttling responses', () => {
  const policy = parseProfile(profile).responsePolicy;
  assert.equal(responseMatchesPolicy(202, undefined, policy), true);
  assert.equal(
    responseMatchesPolicy(401, 'auth.unauthenticated', policy),
    false,
  );
  assert.equal(responseMatchesPolicy(403, 'auth.forbidden', policy), false);
  assert.equal(
    responseMatchesPolicy(429, 'workspace.quota_exceeded', policy),
    false,
  );
});

test('profiles cannot declare authentication failures as expected', () => {
  assert.throws(
    () =>
      parseProfile({
        ...profile,
        responsePolicy: { expectedStatuses: [401], expectedProblemCodes: [] },
      }),
    /authentication and authorization failures/u,
  );
});

test('an intentional rate-limit policy must name its stable problem code', () => {
  assert.throws(
    () =>
      parseProfile({
        ...profile,
        responsePolicy: { expectedStatuses: [429], expectedProblemCodes: [] },
      }),
    /rate-limit problem code/u,
  );
  const parsed = parseProfile({
    ...profile,
    responsePolicy: {
      expectedStatuses: [429],
      expectedProblemCodes: ['webhook.rate_limited'],
    },
  });
  assert.equal(
    responseMatchesPolicy(429, 'webhook.rate_limited', parsed.responsePolicy),
    true,
  );
});

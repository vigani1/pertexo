import { describe, expect, it } from 'vitest';

import { failureAlertAttention } from '../../../src/inbox/observations/failure-alert-state.js';

const destination = {
  connection_id: 'connection',
  destination_status: 'enabled',
  kind: 'email',
  side_effect_class: 'idempotent_with_key',
  current_config_version: 3,
} as const;
const connection = {
  auth_type: 'resend_api_key',
  provider_key: 'email',
  status: 'active',
  current_secret_version_id: 'secret',
  secret_exists: true,
};

// The database's foreign keys refuse these states today, so no stored row can reach
// them. The rule still has to answer if that ever changes.
describe('a policy whose destination has lost what it sends with', () => {
  it.each([
    ['names no connection', { connection: undefined }],
    [
      'has lost its secret',
      { connection: { ...connection, secret_exists: false } },
    ],
  ])('needs someone when it %s', (_cause, facts) => {
    expect(
      failureAlertAttention({
        destination,
        hasPolicy: true,
        latestAlertUndelivered: false,
        ...facts,
      }).active,
    ).toBe(true);
  });

  it('does not while the destination can send', () => {
    expect(
      failureAlertAttention({
        destination,
        connection,
        hasPolicy: true,
        latestAlertUndelivered: false,
      }).active,
    ).toBe(false);
  });
});

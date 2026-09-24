import { describe, expect, it } from 'vitest';

import { assertBetterAuthCutoverReady } from '../src/identity/better-auth-cutover-preflight.js';

describe('Better Auth cutover preflight', () => {
  it('accepts only an empty legacy exposure inventory', () => {
    expect(() => {
      assertBetterAuthCutoverReady({
        activeUsersWithoutNativeMethod: 0,
        activeUsersWithUnmigratedLegacyIdentity: 0,
        liveLegacySessions: 0,
      });
    }).not.toThrow();
    for (const field of [
      'activeUsersWithoutNativeMethod',
      'activeUsersWithUnmigratedLegacyIdentity',
      'liveLegacySessions',
    ] as const) {
      expect(() => {
        assertBetterAuthCutoverReady({
          activeUsersWithoutNativeMethod: 0,
          activeUsersWithUnmigratedLegacyIdentity: 0,
          liveLegacySessions: 0,
          [field]: 1,
        });
      }).toThrow();
    }
  });
});

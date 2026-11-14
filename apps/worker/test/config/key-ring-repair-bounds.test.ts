import { randomBytes } from 'node:crypto';

import {
  KEY_RING_REPAIR_BOUNDS,
  StartupSettingError,
  describeProcessFailure,
} from '@pertexo/observability/startup';
import {
  applicationKeyVersionSchema,
  parseApplicationPreviousKeys,
  validateApplicationKeyRing,
} from '@pertexo/secrets/server';
import { describe, expect, it } from 'vitest';

// Observability tells the operator the key ring's limits but can't import
// secrets, which enforces them; this worker sees both and holds them equal.
const { keyBytes, maxPreviousKeys, maxVersionLength } = KEY_RING_REPAIR_BOUNDS;

const key = (bytes: number) => randomBytes(bytes).toString('base64');
const previousKeys = (count: number) =>
  JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      version: `retired-${String(index)}`,
      key: key(keyBytes),
    })),
  );

describe('the key ring limits the startup repair text states', () => {
  it('accepts a key of the stated size and refuses one byte less', () => {
    expect(() =>
      validateApplicationKeyRing({
        current: { version: 'v1', key: key(keyBytes) },
      }),
    ).not.toThrow();
    expect(() =>
      validateApplicationKeyRing({
        current: { version: 'v1', key: key(keyBytes - 1) },
      }),
    ).toThrow();
  });

  it('keeps the stated number of retired keys and refuses one more', () => {
    expect(
      parseApplicationPreviousKeys(previousKeys(maxPreviousKeys)),
    ).toHaveLength(maxPreviousKeys);
    expect(() =>
      parseApplicationPreviousKeys(previousKeys(maxPreviousKeys + 1)),
    ).toThrow();
  });

  it('accepts a key version of the stated length and refuses a longer one', () => {
    expect(
      applicationKeyVersionSchema.safeParse('v'.repeat(maxVersionLength))
        .success,
    ).toBe(true);
    expect(
      applicationKeyVersionSchema.safeParse('v'.repeat(maxVersionLength + 1))
        .success,
    ).toBe(false);
  });

  it('tells the operator those limits', () => {
    expect(
      describeProcessFailure(
        new StartupSettingError(
          'AUTH_MAIL_PREVIOUS_KEYS',
          'previous_keys_required',
        ),
      ),
    ).toContain(
      `at most ${String(maxPreviousKeys)} unique historical key versions and their base64 encoded ${String(keyBytes)}-byte keys`,
    );
    expect(
      describeProcessFailure(
        new StartupSettingError(
          'AUTH_MAIL_KEY_VERSION',
          'key_version_required',
        ),
      ),
    ).toContain(`at most ${String(maxVersionLength)} characters`);
  });
});

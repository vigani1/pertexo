import { describe, expect, it } from 'vitest';

import { DEFAULT_CODE_SETTINGS, parseCodeSettings } from '../../src/index.js';

// docs/guides/code.md "Limits": instance maximum time 30 seconds by default,
// up to 300; heap 128 MB by default, 32 MB to 1 GB; 2 concurrent tasks by
// default, 1 to 16.
describe('Code runner settings from the environment', () => {
  it('defaults to the documented limits', () => {
    expect(parseCodeSettings({})).toEqual({
      enabled: true,
      memoryMiB: 128,
      maximumSeconds: 30,
      concurrency: 2,
      extraPackages: [],
      pythonPackages: [],
    });
    expect(DEFAULT_CODE_SETTINGS).toEqual(parseCodeSettings({}));
  });

  it.each([
    ['CODE_RUNNER_MEMORY_MB', 'memoryMiB', 32, 1_024],
    ['CODE_RUNNER_MAX_SECONDS', 'maximumSeconds', 1, 300],
    ['CODE_RUNNER_CONCURRENCY', 'concurrency', 1, 16],
  ] as const)(
    'accepts %s from %i to %i and nothing outside',
    (variable, setting, minimum, maximum) => {
      expect(parseCodeSettings({ [variable]: String(minimum) })).toMatchObject({
        [setting]: minimum,
      });
      expect(parseCodeSettings({ [variable]: String(maximum) })).toMatchObject({
        [setting]: maximum,
      });
      expect(() =>
        parseCodeSettings({ [variable]: String(minimum - 1) }),
      ).toThrow();
      expect(() =>
        parseCodeSettings({ [variable]: String(maximum + 1) }),
      ).toThrow();
    },
  );

  // engine-11: a malformed package list throws a bare SyntaxError.
  it.fails.each(['CODE_RUNNER_PACKAGES', 'CODE_RUNNER_PYTHON_PACKAGES'])(
    'names %s when its package list is not JSON',
    (variable) => {
      expect(() => parseCodeSettings({ [variable]: 'lodash' })).toThrow(
        variable,
      );
    },
  );
});

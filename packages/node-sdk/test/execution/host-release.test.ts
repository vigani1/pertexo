import { describe, expect, it } from 'vitest';
import { hostReleaseCompatibility } from '../../src/server.js';

describe('host release compatibility', () => {
  it.each([
    ['0.2.0', 'compatible'],
    ['0.2.9', 'compatible'],
    ['0.2.10', 'incompatible'],
    ['0.1.9', 'incompatible'],
  ] as const)('classifies host %s as %s', (host, expected) => {
    expect(
      hostReleaseCompatibility({ min: '0.2.0', below: '0.2.10' }, host),
    ).toBe(expected);
  });

  it.each(['0.02.0', '0.2.0-beta', '0.2.0+build', '0.2.*', '0.2', '0.2.0\n'])(
    'rejects malformed range endpoint %j',
    (min) => {
      expect(hostReleaseCompatibility({ min, below: '1.0.0' })).toBe('invalid');
    },
  );

  it.each(['0.2.0', '0.3.0'])('rejects min %s at or past below', (min) => {
    expect(hostReleaseCompatibility({ min, below: '0.2.0' })).toBe('invalid');
  });
});

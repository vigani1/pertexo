import { describe, expect, it } from 'vitest';

import { createApplicationSecretEnvelope } from '../src/security/application-secret-envelope.js';

describe('application secret envelope', () => {
  it('opens only with matching associated data and supports prior keys', () => {
    const prior = createApplicationSecretEnvelope({
      current: {
        version: 'v1',
        key: Buffer.alloc(32, 1).toString('base64'),
      },
    });
    const sealed = prior.seal('sensitive invitation token', 'attempt-1');
    const rotated = createApplicationSecretEnvelope({
      current: {
        version: 'v2',
        key: Buffer.alloc(32, 2).toString('base64url'),
      },
      previous: [
        { version: 'v1', key: Buffer.alloc(32, 1).toString('base64') },
      ],
    });

    expect(rotated.open(sealed, 'attempt-1')).toBe(
      'sensitive invitation token',
    );
    expect(() => rotated.open(sealed, 'attempt-2')).toThrow();
  });
});

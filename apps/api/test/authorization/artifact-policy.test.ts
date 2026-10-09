import { describe, expect, it } from 'vitest';
import { hasCapability } from '../../src/authorization/policy.js';
import { ROLES } from '../../src/authorization/types.js';

describe('artifact workspace capability policy', () => {
  it.each(ROLES)(
    'allows %s to read but reserves upload for non-viewers',
    (role) => {
      expect(hasCapability(role, 'artifact:read')).toBe(true);
      expect(hasCapability(role, 'artifact:upload')).toBe(role !== 'viewer');
    },
  );
});

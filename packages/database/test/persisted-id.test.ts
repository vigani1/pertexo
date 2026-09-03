import { describe, expect, it } from 'vitest';

import { generatePersistedId } from '../src/platform/persisted-id.js';

describe('persisted identifiers', () => {
  it('generates UUIDv7 values in monotonic order', () => {
    const generated = Array.from({ length: 128 }, generatePersistedId);

    expect(new Set(generated).size).toBe(generated.length);
    expect(generated.every((value) => value[14] === '7')).toBe(true);
    expect(generated).toEqual([...generated].sort());
  });
});

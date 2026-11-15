import { describe, expect, it } from 'vitest';
import { databaseClockEpochSeconds } from '../../src/shared/database-clock.repository.js';

describe('database clock readings', () => {
  it('keeps the microseconds PostgreSQL wrote', () => {
    expect(databaseClockEpochSeconds('2026-11-15T10:00:00.123456Z')).toBe(
      Number('1794736800.123456'),
    );
  });

  it('reads a whole second exactly', () => {
    expect(databaseClockEpochSeconds('1970-01-01T00:00:01.000000Z')).toBe(1);
  });
});

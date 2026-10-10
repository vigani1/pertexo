import { describe, expect, it } from 'vitest';

import { CoordinatorRunStateCorruptError } from '../../../src/runs/advance/contract.js';
import { parseClaimedWakeups } from '../../../src/runs/wakeups/scan-result.js';

describe('coordinator wakeup scan result', () => {
  it.each([0, 1, 100])('accepts an exact bounded count of %i', (claimed) => {
    expect(parseClaimedWakeups([{ claimed }], 100)).toBe(claimed);
  });

  it.each([
    { rows: [] },
    { rows: [{ claimed: 0 }, { claimed: 0 }] },
    { rows: [{ claimed: -1 }] },
    { rows: [{ claimed: 101 }] },
    { rows: [{ claimed: 1.5 }] },
    { rows: [{ claimed: Number.NaN }] },
    { rows: [{ claimed: '1' }] },
    { rows: [{ claimed: undefined }] },
  ])('fails closed for malformed rows %#', ({ rows }) => {
    expect(() => parseClaimedWakeups(rows, 100)).toThrow(
      CoordinatorRunStateCorruptError,
    );
  });
});

import { describe, expect, it } from 'vitest';

import { publicationRetryDelay } from '../../../src/transport/outbox/dispatch/delivery.js';

describe('the delay before publishing again', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [5, 16_000],
    [6, 30_000],
    [10_000, 30_000],
  ])('after %i attempts is %i ms', (attempts, delay) => {
    expect(publicationRetryDelay(1_000, attempts)).toBe(delay);
  });
});

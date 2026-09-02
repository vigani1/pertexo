import { describe, expect, it, vi } from 'vitest';

import {
  RATE_LIMIT_CONSUMER,
  RateLimitModule,
} from '../../src/platform/rate-limit/rate-limit.module.js';

describe('rate-limit module wiring', () => {
  it('uses an explicitly supplied consumer without creating a runtime', () => {
    const override = { consume: vi.fn() };
    const module = RateLimitModule.register(
      'redis://unused.example.test',
      override,
    );

    expect(module.providers).toContainEqual({
      provide: RATE_LIMIT_CONSUMER,
      useValue: override,
    });
  });

  it('creates the owned Redis runtime when no consumer is supplied', () => {
    const module = RateLimitModule.register('redis://127.0.0.1:6379');
    const provider = module.providers?.find(
      (candidate) =>
        typeof candidate === 'object' &&
        'provide' in candidate &&
        candidate.provide === RATE_LIMIT_CONSUMER,
    );

    expect(provider).toMatchObject({ provide: RATE_LIMIT_CONSUMER });
    expect(provider).toHaveProperty('useValue');
  });
});

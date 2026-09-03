import { describe, expect, it, vi } from 'vitest';

import {
  RATE_LIMIT_CONSUMER,
  RateLimitModule,
} from '../../src/platform/rate-limit/rate-limit.module.js';

function ownsShutdownHook(
  value: unknown,
): value is { onApplicationShutdown(): Promise<void> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'onApplicationShutdown' in value &&
    typeof value.onApplicationShutdown === 'function'
  );
}

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

  it('creates and shuts down the owned Redis runtime when no consumer is supplied', async () => {
    const module = RateLimitModule.register('redis://127.0.0.1:6379');
    const provider = module.providers?.find(
      (candidate) =>
        typeof candidate === 'object' &&
        'provide' in candidate &&
        candidate.provide === RATE_LIMIT_CONSUMER,
    );

    expect(provider).toMatchObject({ provide: RATE_LIMIT_CONSUMER });
    expect(provider).toHaveProperty('useValue');
    const candidate: unknown = provider;
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      !('useValue' in candidate)
    ) {
      throw new Error('Owned rate-limit runtime shutdown hook missing');
    }
    const runtime: unknown = candidate.useValue;
    if (!ownsShutdownHook(runtime)) {
      throw new Error('Owned rate-limit runtime shutdown hook missing');
    }
    await expect(runtime.onApplicationShutdown()).resolves.toBeUndefined();
  });
});

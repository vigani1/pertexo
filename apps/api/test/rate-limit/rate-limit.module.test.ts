import { describe, expect, it, vi } from 'vitest';

import {
  RATE_LIMIT_CONSUMER,
  RateLimitModule,
} from '../../src/platform/rate-limit/rate-limit.module.js';
import type { ApiShutdownCoordinator } from '../../src/platform/health/drain-state.js';

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
    expect(provider).toHaveProperty('useFactory');
    const candidate: unknown = provider;
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      !('useFactory' in candidate) ||
      typeof candidate.useFactory !== 'function'
    ) {
      throw new Error('Owned rate-limit runtime factory missing');
    }
    const registered: (() => unknown)[] = [];
    const register = vi.fn((_label: string, close: () => unknown): void => {
      registered.push(close);
    });
    const shutdown = {
      register,
    } as unknown as ApiShutdownCoordinator;
    const factory = candidate as {
      useFactory: (coordinator: ApiShutdownCoordinator) => unknown;
    };
    const runtime = factory.useFactory(shutdown);

    expect(runtime).toBeDefined();
    expect(register).toHaveBeenCalledWith('rate-limit', expect.any(Function));
    await expect(registered[0]?.()).resolves.toBeUndefined();
  });
});

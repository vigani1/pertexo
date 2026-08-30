import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  RateLimitInterceptor,
  type RateLimitConsumer,
  type RateLimitMetricRecorder,
} from '../../src/platform/rate-limit/interceptor.js';
import { RATE_LIMIT_METADATA } from '../../src/platform/rate-limit/metadata.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';

// Nest metadata lookup requires a controller class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class TestController {}

const providerTestHandler = (): void => undefined;
const authenticatedReadHandler = (): void => undefined;

Reflect.defineMetadata(
  RATE_LIMIT_METADATA,
  'provider_test',
  providerTestHandler,
);
Reflect.defineMetadata(
  RATE_LIMIT_METADATA,
  'authenticated_read',
  authenticatedReadHandler,
);

function context(handler: () => void): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({
        ip: '203.0.113.9',
        headers: { origin: 'https://app.example.test/path' },
        params: { workspaceId, connectionId },
        identitySession: { userId: actorId },
      }),
    }),
  } as unknown as ExecutionContext;
}

function metrics(): RateLimitMetricRecorder {
  return { record: vi.fn() };
}

describe('rate-limit interceptor', () => {
  it('rejects before controller work with a generic bounded problem', async () => {
    const consume = vi.fn().mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 7,
      limitedDimension: 'connection',
    });
    const consumer: RateLimitConsumer = { consume };
    const handle = vi.fn(() => of('called'));
    const next: CallHandler = { handle };
    const interceptor = new RateLimitInterceptor(
      new Reflector(),
      consumer,
      metrics(),
    );

    await expect(
      interceptor.intercept(context(providerTestHandler), next),
    ).rejects.toMatchObject({
      code: 'request.rate_limited',
      details: { retryAfterSeconds: 7 },
    });
    expect(handle).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointClass: 'provider_test',
        // Vitest's asymmetric matcher is intentionally dynamic at this boundary.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        dimensions: expect.arrayContaining([
          { kind: 'actor', identifier: actorId, limit: 10 },
          { kind: 'workspace', identifier: workspaceId, limit: 20 },
          { kind: 'connection', identifier: connectionId, limit: 5 },
        ]),
      }),
    );
  });

  it('fails open only for endpoint classes whose policy permits it', async () => {
    const consume = vi.fn().mockRejectedValue(new Error('redis unavailable'));
    const consumer: RateLimitConsumer = { consume };
    const handle = vi.fn(() => of('called'));
    const next: CallHandler = { handle };
    const recorder = metrics();
    const interceptor = new RateLimitInterceptor(
      new Reflector(),
      consumer,
      recorder,
    );

    await expect(
      firstValueFrom(
        await interceptor.intercept(context(authenticatedReadHandler), next),
      ),
    ).resolves.toBe('called');
    expect(recorder.record).toHaveBeenCalledWith({
      endpointClass: 'authenticated_read',
      failureMode: 'open',
      outcome: 'backend_error',
    });
  });
});

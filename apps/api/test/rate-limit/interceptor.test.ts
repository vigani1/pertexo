import { HttpRateLimitAdmission } from '../../src/platform/rate-limit/admission.js';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  RateLimitInterceptor,
  type RateLimitMetricRecorder,
} from '../../src/platform/rate-limit/interceptor.js';
import {
  RATE_LIMIT_EXEMPT,
  RATE_LIMIT_METADATA,
} from '../../src/platform/rate-limit/metadata.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';

// Nest metadata lookup requires a controller class token.
// oxlint-disable-next-line typescript/no-extraneous-class
class TestController {}

const providerTestHandler = (): void => undefined;
const authenticatedReadHandler = (): void => undefined;
const identityStartHandler = (): void => undefined;
const exemptHandler = (): void => undefined;
const unclassifiedHandler = (): void => undefined;

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
Reflect.defineMetadata(
  RATE_LIMIT_METADATA,
  'identity_start',
  identityStartHandler,
);
Reflect.defineMetadata(RATE_LIMIT_METADATA, RATE_LIMIT_EXEMPT, exemptHandler);

type TestRequest = Readonly<{
  ip?: string;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  params?: unknown;
  identitySession?: Readonly<{ userId?: string }>;
  authorizedWorkspace?: unknown;
}>;

function context(
  handler: () => void,
  request: TestRequest = {
    ip: '203.0.113.9',
    params: { workspaceId, connectionId },
    identitySession: { userId: actorId },
  },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function metrics(): RateLimitMetricRecorder {
  return { record: vi.fn() };
}

/**
 * Refusing over budget before the controller runs, failing open for reads and
 * closed for mutations while Redis is down, and the quota headers run on the
 * real stack in connections/provider-test.integration.test.ts,
 * headers.integration.test.ts and outage-budget.integration.test.ts. These
 * cases stay because no real stack has a metrics sink that throws or a route
 * without a classification.
 */
describe('rate-limit interceptor', () => {
  it('keeps an allowed decision authoritative when metric recording throws', async () => {
    const handle = vi.fn(() => of('called'));
    const interceptor = new RateLimitInterceptor(
      new Reflector(),
      new HttpRateLimitAdmission(
        { consume: vi.fn().mockResolvedValue({ allowed: true }) },
        {
          record: () => {
            throw new Error('metrics unavailable');
          },
        },
      ),
    );

    await expect(
      firstValueFrom(
        await interceptor.intercept(context(providerTestHandler), { handle }),
      ),
    ).resolves.toBe('called');
    expect(handle).toHaveBeenCalledOnce();
  });

  it('keeps a limited decision authoritative when metric recording throws', async () => {
    const handle = vi.fn(() => of('called'));
    const interceptor = new RateLimitInterceptor(
      new Reflector(),
      new HttpRateLimitAdmission(
        {
          consume: vi.fn().mockResolvedValue({
            allowed: false,
            retryAfterSeconds: 7,
            limitedDimension: 'connection',
          }),
        },
        {
          record: () => {
            throw new Error('metrics unavailable');
          },
        },
      ),
    );

    await expect(
      interceptor.intercept(context(providerTestHandler), { handle }),
    ).rejects.toMatchObject({
      code: 'request.rate_limited',
      details: { retryAfterSeconds: 7 },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([[authenticatedReadHandler]] as const)(
    'keeps the selected backend-failure policy when metric recording throws',
    async (handler) => {
      const handle = vi.fn(() => of('called'));
      const interceptor = new RateLimitInterceptor(
        new Reflector(),
        new HttpRateLimitAdmission(
          {
            consume: vi.fn().mockRejectedValue(new Error('redis unavailable')),
          },
          {
            record: () => {
              throw new Error('metrics unavailable');
            },
          },
        ),
      );

      const result = interceptor.intercept(context(handler), { handle });
      await expect(firstValueFrom(await result)).resolves.toBe('called');
      expect(handle).toHaveBeenCalledOnce();
    },
  );

  it('bypasses explicitly exempt routes and rejects missing classification', async () => {
    const consume = vi.fn();
    const handle = vi.fn(() => of('called'));
    const recorder = metrics();
    const interceptor = new RateLimitInterceptor(
      new Reflector(),
      new HttpRateLimitAdmission({ consume }, recorder),
    );

    await expect(
      firstValueFrom(
        await interceptor.intercept(context(exemptHandler), { handle }),
      ),
    ).resolves.toBe('called');
    await expect(
      interceptor.intercept(context(unclassifiedHandler), { handle }),
    ).rejects.toThrow(/missing rate-limit classification/u);
    expect(consume).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
  });
});

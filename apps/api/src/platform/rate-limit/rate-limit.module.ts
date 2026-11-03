import { CsvExportAdmission } from '../http/csv/admission.js';
import { HttpRateLimitAdmission } from './admission.js';
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import type { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import {
  RateLimitInterceptor,
  type RateLimitMetricRecorder,
} from './interceptor.js';
import { createRateLimitMetricRecorder } from './metrics.js';
import {
  ApiLifecycleModule,
  ApiShutdownCoordinator,
} from '../health/drain-state.js';

/** The outside rate-limit service: Redis in production. */
export type ApiRateLimit = Pick<
  RedisRateLimitRuntime,
  'consume' | 'acquireExclusiveSlot' | 'close'
>;

const RATE_LIMIT_CONCURRENCY = Symbol('RATE_LIMIT_CONCURRENCY');
const RATE_LIMIT_METRICS = Symbol('RATE_LIMIT_METRICS');

@Module({})
// Nest requires a class as the dynamic module identity.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class RateLimitModule {
  public static register(rateLimit: ApiRateLimit): DynamicModule {
    return {
      module: RateLimitModule,
      imports: [ApiLifecycleModule],
      exports: [
        HttpRateLimitAdmission,
        RATE_LIMIT_CONCURRENCY,
        CsvExportAdmission,
      ],
      providers: [
        {
          provide: CsvExportAdmission,
          inject: [RATE_LIMIT_CONCURRENCY],
          useFactory: (slots: ApiRateLimit) => new CsvExportAdmission(slots),
        },
        {
          provide: RATE_LIMIT_CONCURRENCY,
          inject: [ApiShutdownCoordinator],
          useFactory: (shutdown: ApiShutdownCoordinator) => {
            shutdown.register('rate-limit', () => rateLimit.close());
            return rateLimit;
          },
        },
        {
          provide: RATE_LIMIT_METRICS,
          useFactory: createRateLimitMetricRecorder,
        },
        {
          provide: HttpRateLimitAdmission,
          inject: [RATE_LIMIT_CONCURRENCY, RATE_LIMIT_METRICS],
          useFactory: (
            consumer: ApiRateLimit,
            metrics: RateLimitMetricRecorder,
          ) => new HttpRateLimitAdmission(consumer, metrics),
        },
        {
          provide: APP_INTERCEPTOR,
          inject: [Reflector, HttpRateLimitAdmission],
          useFactory: (
            reflector: Reflector,
            admission: HttpRateLimitAdmission,
          ) => new RateLimitInterceptor(reflector, admission),
        },
      ],
    };
  }
}

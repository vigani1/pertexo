import { HttpRateLimitAdmission } from './admission.js';
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import {
  RateLimitInterceptor,
  type RateLimitConsumer,
  type RateLimitMetricRecorder,
} from './interceptor.js';
import { createRateLimitMetricRecorder } from './metrics.js';
import { ApiShutdownCoordinator } from '../health/drain-state.js';

export const RATE_LIMIT_CONSUMER = Symbol('RATE_LIMIT_CONSUMER');
const RATE_LIMIT_METRICS = Symbol('RATE_LIMIT_METRICS');

@Module({})
// Nest requires a class as the dynamic module identity.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class RateLimitModule {
  public static register(
    redisUrl: string,
    override?: RateLimitConsumer,
  ): DynamicModule {
    return {
      module: RateLimitModule,
      exports: [HttpRateLimitAdmission],
      providers: [
        override === undefined
          ? {
              provide: RATE_LIMIT_CONSUMER,
              inject: [ApiShutdownCoordinator],
              useFactory: (shutdown: ApiShutdownCoordinator) => {
                const runtime = new RedisRateLimitRuntime(redisUrl);
                shutdown.register('rate-limit', () => runtime.close());
                return runtime;
              },
            }
          : { provide: RATE_LIMIT_CONSUMER, useValue: override },
        {
          provide: RATE_LIMIT_METRICS,
          useFactory: createRateLimitMetricRecorder,
        },
        {
          provide: HttpRateLimitAdmission,
          inject: [RATE_LIMIT_CONSUMER, RATE_LIMIT_METRICS],
          useFactory: (
            consumer: RateLimitConsumer,
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

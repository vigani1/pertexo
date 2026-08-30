import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import {
  RateLimitInterceptor,
  type RateLimitConsumer,
  type RateLimitMetricRecorder,
} from './interceptor.js';
import { createRateLimitMetricRecorder } from './metrics.js';

export const RATE_LIMIT_CONSUMER = Symbol('RATE_LIMIT_CONSUMER');
export const RATE_LIMIT_METRICS = Symbol('RATE_LIMIT_METRICS');

class ApiRedisRateLimitRuntime
  extends RedisRateLimitRuntime
  implements OnApplicationShutdown
{
  public onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}

@Module({})
// Nest requires a class as the dynamic module identity.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class RateLimitModule {
  public static register(
    redisUrl: string,
    override?: RateLimitConsumer,
  ): DynamicModule {
    const runtime = override ?? new ApiRedisRateLimitRuntime(redisUrl);
    return {
      module: RateLimitModule,
      providers: [
        { provide: RATE_LIMIT_CONSUMER, useValue: runtime },
        {
          provide: RATE_LIMIT_METRICS,
          useFactory: createRateLimitMetricRecorder,
        },
        {
          provide: APP_INTERCEPTOR,
          inject: [Reflector, RATE_LIMIT_CONSUMER, RATE_LIMIT_METRICS],
          useFactory: (
            reflector: Reflector,
            consumer: RateLimitConsumer,
            metricRecorder: RateLimitMetricRecorder,
          ) => new RateLimitInterceptor(reflector, consumer, metricRecorder),
        },
      ],
    };
  }
}

import { Global, Module } from '@nestjs/common';
import type {
  DynamicModule,
  MiddlewareConsumer,
  NestModule,
  Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import {
  HTTP_APPLICATION_ERROR_MAPPERS,
  HTTP_ERROR_LOGGER,
  ProblemDetailsFilter,
  type HttpApplicationErrorMapper,
  type HttpErrorLogger,
} from './problem-details.filter.js';
import {
  RequestContextMiddleware,
  RequestContextStore,
} from './request-context.js';

export const REQUEST_CONTEXT_STORE = Symbol('REQUEST_CONTEXT_STORE');

const contextStoreProvider: Provider = {
  provide: REQUEST_CONTEXT_STORE,
  useExisting: RequestContextStore,
};

const problemFilterProvider: Provider = {
  provide: APP_FILTER,
  useFactory: (
    contexts: RequestContextStore,
    logger: HttpErrorLogger,
    applicationErrorMappers: readonly HttpApplicationErrorMapper[],
  ): ProblemDetailsFilter =>
    new ProblemDetailsFilter(contexts, logger, applicationErrorMappers),
  inject: [
    REQUEST_CONTEXT_STORE,
    HTTP_ERROR_LOGGER,
    HTTP_APPLICATION_ERROR_MAPPERS,
  ],
};

@Global()
@Module({
  providers: [
    RequestContextStore,
    contextStoreProvider,
    RequestContextMiddleware,
  ],
  exports: [
    RequestContextStore,
    REQUEST_CONTEXT_STORE,
    RequestContextMiddleware,
  ],
})
export class HttpPlatformModule implements NestModule {
  public static register(
    logger: HttpErrorLogger,
    applicationErrorMappers: readonly HttpApplicationErrorMapper[] = [],
  ): DynamicModule {
    return {
      module: HttpPlatformModule,
      providers: [
        { provide: HTTP_ERROR_LOGGER, useValue: logger },
        {
          provide: HTTP_APPLICATION_ERROR_MAPPERS,
          useValue: applicationErrorMappers,
        },
        problemFilterProvider,
      ],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

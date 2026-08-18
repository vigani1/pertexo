import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  MiddlewareConsumer,
  NestModule,
  Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import {
  HTTP_ERROR_LOGGER,
  ProblemDetailsFilter,
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
  ): ProblemDetailsFilter => new ProblemDetailsFilter(contexts, logger),
  inject: [REQUEST_CONTEXT_STORE, HTTP_ERROR_LOGGER],
};

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
  public static register(logger: HttpErrorLogger): DynamicModule {
    return {
      module: HttpPlatformModule,
      providers: [
        { provide: HTTP_ERROR_LOGGER, useValue: logger },
        problemFilterProvider,
      ],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

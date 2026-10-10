import type { WorkspaceDatabase } from '@pertexo/database/platform';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';

import {
  acquireApiRuntimes,
  assertValidRuntimeSources,
  cleanupApiRuntimes,
  throwStartupFailure,
  type ApiApplicationDependencies,
} from './api-runtimes.js';
import { AppModule } from './app.module.js';
import type { ApiConfig } from './platform/config/api.js';
import { WORKSPACE_DATABASE } from './platform/database/database.module.js';
import { ApiShutdownCoordinator } from './platform/health/drain-state.js';
import { NestLoggerAdapter } from './platform/observability/observability.module.js';
import { registerApiMetrics } from './platform/observability/api-metrics.js';
import { registerWebhookIngress } from './webhooks/ingress.js';
import { registerWorkflowPortabilityJsonParser } from './workflow-authoring/portability/json-parser.js';
import type { RateLimitConsumer } from './platform/rate-limit/interceptor.js';
import { RATE_LIMIT_CONSUMER } from './platform/rate-limit/rate-limit.module.js';
import {
  registerAuthenticationCapabilities,
  registerBetterAuthHandler,
} from './authentication/better-auth/fastify.js';

export type { ApiApplicationDependencies } from './api-runtimes.js';

export async function createApiApplication(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): Promise<NestFastifyApplication> {
  assertValidRuntimeSources(config, dependencies);
  const nestLogger = new NestLoggerAdapter(dependencies.logger);
  const runtimes = await acquireApiRuntimes(config, dependencies);
  const {
    artifactRuntime,
    connectionRuntime,
    databaseRuntime,
    identityRuntime,
    notificationRuntime,
    scheduleRuntime,
    webhookRuntime,
    workflowRuntime,
  } = runtimes;
  const fastifyAdapter = new FastifyAdapter({
    trustProxy:
      config.trustedProxyCidrs === undefined ||
      config.trustedProxyCidrs.length === 0
        ? false
        : [...config.trustedProxyCidrs],
  });
  let application: NestFastifyApplication;
  try {
    application = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config, {
        logger: dependencies.logger,
        telemetry: dependencies.telemetry,
        ...(databaseRuntime === undefined ? {} : { databaseRuntime }),
        ...(dependencies.database === undefined
          ? {}
          : { database: dependencies.database }),
        ...(dependencies.rateLimitConsumer === undefined
          ? {}
          : { rateLimitConsumer: dependencies.rateLimitConsumer }),
        ...(identityRuntime === undefined ? {} : { identityRuntime }),
        ...(workflowRuntime === undefined ? {} : { workflowRuntime }),
        ...(connectionRuntime === undefined ? {} : { connectionRuntime }),
        ...(webhookRuntime === undefined ? {} : { webhookRuntime }),
        ...(scheduleRuntime === undefined ? {} : { scheduleRuntime }),
        ...(notificationRuntime === undefined ? {} : { notificationRuntime }),
        ...(artifactRuntime === undefined ? {} : { artifactRuntime }),
      }),
      fastifyAdapter,
      { abortOnError: false, logger: nestLogger },
    );
  } catch (error: unknown) {
    const cleanupErrors = await cleanupApiRuntimes(runtimes);
    throwStartupFailure(error, cleanupErrors);
  }

  const shutdown = application.get(ApiShutdownCoordinator);
  const nestClose = application.close.bind(application);
  let closePromise: Promise<void> | undefined;
  const coordinatedClose = (): Promise<void> => {
    closePromise ??= nestClose().then(() => {
      shutdown.throwIfFailed();
    });
    return closePromise;
  };
  const lifecycleApplication = new Proxy(application, {
    get(target, property, receiver) {
      if (property === 'close') return coordinatedClose;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  application.enableShutdownHooks();
  try {
    const fastifyInstance: FastifyInstance = fastifyAdapter.getInstance();
    registerWorkflowPortabilityJsonParser(fastifyAdapter);
    registerApiMetrics(fastifyInstance);
    registerAuthenticationCapabilities(fastifyInstance, {
      password: {
        enabled: identityRuntime !== undefined,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: Object.keys(
        config.identity?.betterAuth.providers ?? {},
      ) as ('google' | 'microsoft' | 'github' | 'apple')[],
    });
    if (identityRuntime !== undefined && config.identity !== undefined)
      registerBetterAuthHandler(fastifyInstance, {
        handler: identityRuntime.betterAuth.auth.handler,
        rateLimitConsumer:
          application.get<RateLimitConsumer>(RATE_LIMIT_CONSUMER),
        publicOrigin: config.identity.publicWebOrigin,
        sessionCookie: {
          secure: config.identity.session.secureCookie,
          sameSite: config.identity.session.sameSite,
          maxAgeSeconds: Math.floor(config.identity.session.ttlMillis / 1_000),
        },
      });
    await application.init();
    if (webhookRuntime !== undefined) {
      registerWebhookIngress(fastifyInstance, webhookRuntime.ingress);
    }
    await application
      .get<WorkspaceDatabase>(WORKSPACE_DATABASE)
      .checkReadiness();
    await scheduleRuntime?.checkReadiness();
    await notificationRuntime?.checkReadiness();
    await artifactRuntime?.checkReadiness();
  } catch (error: unknown) {
    try {
      await coordinatedClose();
    } catch (cleanupError: unknown) {
      throwStartupFailure(error, [cleanupError]);
    }
    throw error;
  }

  return lifecycleApplication;
}

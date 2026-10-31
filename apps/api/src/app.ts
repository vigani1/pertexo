import { registerCallbackIngress } from './webhooks/callbacks/ingress.js';
import { registerDirectoryTransport } from './authentication/federation/provisioning/transport/register.js';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';

import {
  acquireApiRuntimes,
  cleanupApiRuntimes,
  throwStartupFailure,
  type ApiApplicationDependencies,
} from './api-runtimes.js';
import type { ApiRuntimeSet } from './platform/application/contract.js';
import { AppModule } from './app.module.js';
import { configuredSocialProviders } from './authentication/index.js';
import type { ApiConfig } from './platform/config/api.js';
import { WORKSPACE_DATABASE } from './platform/database/module.js';
import { ApiShutdownCoordinator } from './platform/health/drain-state.js';
import { NestLoggerAdapter } from './platform/observability/module.js';
import { registerApiMetrics } from './platform/observability/api-metrics.js';
import { registerResponseSecurityHeaders } from './platform/http/response-security.js';
import { registerWebhookIngress } from './webhooks/ingress/register.js';
import { registerDataTableExportTransport } from './data-tables/export/transport.js';
import { registerNoticeUnsubscribeTransport } from './notifications/preferences/transport.js';
import { registerWorkflowPortabilityJsonParser } from './workflow-authoring/portability/json-parser.js';
import {
  registerAuthenticationCapabilities,
  registerBetterAuthHandler,
} from './authentication/better-auth/fastify.js';

export type { ApiApplicationDependencies } from './api-runtimes.js';

export async function createApiApplication(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): Promise<NestFastifyApplication> {
  const runtimes = await acquireApiRuntimes(config, dependencies);
  return assembleApiApplication(config, dependencies, runtimes);
}

/** Builds and starts the application; it owns the runtimes from here on. */
export async function assembleApiApplication(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
  runtimes: ApiRuntimeSet,
): Promise<NestFastifyApplication> {
  const nestLogger = new NestLoggerAdapter(dependencies.logger);
  const {
    artifactRuntime,
    callbackRuntime,
    identityRuntime,
    notificationRuntime,
    rateLimit,
    scheduleRuntime,
    webhookRuntime,
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
      AppModule.register(config, { ...runtimes, ...dependencies }),
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
    registerResponseSecurityHeaders(fastifyInstance);
    registerWorkflowPortabilityJsonParser(fastifyAdapter);
    registerNoticeUnsubscribeTransport(fastifyAdapter);
    registerDataTableExportTransport(fastifyAdapter);
    registerApiMetrics(fastifyInstance);
    registerAuthenticationCapabilities(
      fastifyInstance,
      {
        password: {
          enabled: identityRuntime !== undefined,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: configuredSocialProviders(
          config.identity?.betterAuth.providers,
        ),
      },
      async () =>
        identityRuntime?.betterAuth.signUp.availableToEveryone() ?? false,
    );
    if (identityRuntime !== undefined && config.identity !== undefined)
      registerBetterAuthHandler(fastifyInstance, {
        handler: identityRuntime.betterAuth.auth.handler,
        rateLimitConsumer: rateLimit,
        publicOrigin: config.identity.publicWebOrigin,
        sessionCookie: {
          secure: config.identity.session.secureCookie,
          sameSite: config.identity.session.sameSite,
          maxAgeSeconds: Math.floor(config.identity.session.ttlMillis / 1_000),
        },
      });
    if (identityRuntime !== undefined && config.identity !== undefined)
      registerDirectoryTransport(fastifyInstance, {
        store: identityRuntime.directory,
        rateLimitConsumer: rateLimit,
        publicOrigin: config.identity.publicWebOrigin,
      });
    await application.init();
    if (callbackRuntime !== undefined)
      registerCallbackIngress(fastifyInstance, {
        ...callbackRuntime,
        rateLimitConsumer: rateLimit,
        logger: dependencies.logger,
      });
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

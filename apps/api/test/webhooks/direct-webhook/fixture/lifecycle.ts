import { DEFAULT_INSTANCE_LIMITS } from '@pertexo/core/runs';
import { createWebhookTestEventStore } from '@pertexo/core/triggers';
import { WebhookTestEventService } from '../../../../src/webhooks/test-events/service.js';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';

import {
  createIdentityWorkspaceDatabase,
  createWebhookTriggerDatabase,
  createWorkflowTriggerReconciliationDatabase,
  type WebhookTriggerDatabase,
} from '@pertexo/core/testing';
import {
  createWorkspaceDatabase,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import { Pool } from 'pg';
import { vi } from 'vitest';
import { createTestApiApplication } from '../../../support/api-application.js';
import { createInitialCheckpoint } from '@pertexo/core/execution';
import type { ApiConfig } from '../../../../src/platform/config/api.js';
import {
  createApiIdentityRuntime,
  type ApiIdentityRuntime,
} from '../../../../src/platform/identity/runtime.module.js';
import { createCoreWorkflowAuthoringDatabase } from '../../../../src/platform/workflow/runtime.module.js';
import { WebhookManagementService } from '../../../../src/webhooks/management/service.js';
import { dropDisconnectedDatabase } from '../../../support/disposable-database.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../../../browser/harness/resource-owner.js';

import {
  adminBaseUrl,
  migrationBaseUrl,
  apiBaseUrl,
  runnerOwnsDatabase,
  databaseName,
  configuredDatabaseUrl,
  ownerRole,
  migrationRole,
  appRole,
  maintenanceRole,
  logger,
  telemetry,
  quoteIdentifier,
} from './environment.js';
import { DeterministicEnvelopeKeys } from './encryption.js';

let admin!: Pool;

export let owner!: Pool;

export let apiPool!: Pool;

let apiConfig!: ReturnType<typeof parseDatabaseConfig>;

export const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);

export let identity!: ReturnType<typeof createIdentityWorkspaceDatabase>;

export let identityRuntime!: ApiIdentityRuntime;

export let authoring!: ReturnType<typeof createCoreWorkflowAuthoringDatabase>;

export let reconciliation!: ReturnType<
  typeof createWorkflowTriggerReconciliationDatabase
>;

export let webhookDatabase!: ReturnType<typeof createWebhookTriggerDatabase>;

let workspaceDatabase!: ReturnType<typeof createWorkspaceDatabase>;

export let encryption!: WebhookTriggerEnvelopeEncryption;

export let service!: WebhookManagementService;

export let testEvents!: ReturnType<typeof createWebhookTestEventStore>;

export let ingressDatabase!: WebhookTriggerDatabase;

export let application!: Awaited<ReturnType<typeof createTestApiApplication>>;

let fixtureOwner: FixtureResourceOwner | undefined;

export const consume = vi.fn<RedisRateLimitRuntime['consume']>();

export const verificationControl = { failVerification: false };

export let origin = '';

async function createFixture(): Promise<FixtureResourceOwner> {
  const resources = new FixtureResourceOwner();
  try {
    admin = resources.acquire(
      'admin pool',
      new Pool({ connectionString: adminBaseUrl, max: 1 }),
      (pool) => pool.end(),
    );
    if (!runnerOwnsDatabase) {
      await admin.query(
        `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(ownerRole)}`,
      );
      resources.acquire(
        'disposable database',
        { name: databaseName },
        ({ name }) => dropDisconnectedDatabase(admin, name),
      );
      await admin.query(
        `revoke all on database ${quoteIdentifier(databaseName)} from public`,
      );
      await admin.query(
        `grant connect on database ${quoteIdentifier(databaseName)} to ${[
          migrationRole,
          appRole,
          maintenanceRole,
        ]
          .map(quoteIdentifier)
          .join(', ')}`,
      );
    }
    owner = resources.acquire(
      'owner pool',
      new Pool({
        connectionString: configuredDatabaseUrl(migrationBaseUrl),
        max: 1,
      }),
      (pool) => pool.end(),
    );
    apiPool = resources.acquire(
      'API assertion pool',
      new Pool({
        connectionString: configuredDatabaseUrl(apiBaseUrl),
        max: 1,
      }),
      (pool) => pool.end(),
    );
    apiConfig = parseDatabaseConfig({
      connectionString: configuredDatabaseUrl(apiBaseUrl),
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 2_000,
      max: 12,
      ownerRole,
    });
    await migrateDatabase({
      connectionString: configuredDatabaseUrl(migrationBaseUrl),
      ownerRole,
      appRole,
      maintenanceRole,
    });
    identity = resources.acquire(
      'identity database',
      createIdentityWorkspaceDatabase(apiConfig),
      (database) => database.close(),
    );
    identityRuntime = resources.acquire(
      'identity runtime',
      await createApiIdentityRuntime(
        {
          publicWebOrigin: 'https://app.example.test',
          session: {
            ttlMillis: 60_000,
            secureCookie: false,
            sameSite: 'lax',
          },
          betterAuth: {
            secret: 'webhook-integration-secret-with-32-plus-characters',
            mailMode: 'local',
            signUpMode: 'open',
            providers: {},
          },
        },
        apiConfig,
      ),
      (runtime) => runtime.close(),
    );
    authoring = resources.acquire(
      'workflow authoring database',
      createCoreWorkflowAuthoringDatabase(apiConfig),
      (database) => database.close(),
    );
    reconciliation = resources.acquire(
      'trigger reconciliation database',
      createWorkflowTriggerReconciliationDatabase(apiConfig),
      (database) => database.close(),
    );
    webhookDatabase = resources.acquire(
      'webhook database',
      createWebhookTriggerDatabase(apiConfig),
      (database) => database.close(),
    );
    workspaceDatabase = resources.acquire(
      'workspace database',
      createWorkspaceDatabase(apiConfig),
      (database) => database.close(),
    );
    encryption = new WebhookTriggerEnvelopeEncryption(
      new DeterministicEnvelopeKeys(),
    );
    service = new WebhookManagementService(webhookDatabase, encryption);
    testEvents = resources.acquire(
      'test event store',
      createWebhookTestEventStore(apiConfig),
      (store) => store.close(),
    );
    ingressDatabase = {
      configureAuthentication: (input) =>
        webhookDatabase.configureAuthentication(input),
      readResponse: (input) => webhookDatabase.readResponse(input),
      provision: (input) => webhookDatabase.provision(input),
      rotateEndpoint: (input) => webhookDatabase.rotateEndpoint(input),
      rotateSecret: (input) => webhookDatabase.rotateSecret(input),
      getHealth: (input) => webhookDatabase.getHealth(input),
      resolveVerification: async (endpointKeyHash) => {
        if (verificationControl.failVerification)
          throw new Error('forced webhook verification outage');
        return webhookDatabase.resolveVerification(endpointKeyHash);
      },
      consumeIngressLimit: (endpointKeyHash) =>
        webhookDatabase.consumeIngressLimit(endpointKeyHash),
      acceptVerifiedDelivery: (input) =>
        webhookDatabase.acceptVerifiedDelivery(input),
      listDeliveries: (input) => webhookDatabase.listDeliveries(input),
      recordRejectedDelivery: (input) =>
        webhookDatabase.recordRejectedDelivery(input),
      close: () => Promise.resolve(),
    };
    const config: ApiConfig = {
      capacity: DEFAULT_INSTANCE_LIMITS,
      webhookEndpointBurstLimit:
        DEFAULT_INSTANCE_LIMITS.webhookEndpointBurstLimit,
      codeSettings: DEFAULT_CODE_SETTINGS,
      database: apiConfig,
      host: '127.0.0.1',
      nodeEnv: 'test',
      observability: {
        serviceName: 'pertexo-api-webhook-integration',
        serviceVersion: 'test',
        environment: 'test',
        logLevel: 'silent',
        otlpHeaders: {},
      },
      port: 3000,
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
    };
    const rateLimiter = resources.acquire(
      'rate limiter',
      new RedisRateLimitRuntime(config.redisUrl),
      (value) => value.close(),
    );
    consume.mockImplementation((decision) => rateLimiter.consume(decision));
    application = resources.acquire(
      'API application',
      await createTestApiApplication(config, {
        database: workspaceDatabase,
        rateLimitConsumer: { consume },
        identityRuntime,
        webhookRuntime: {
          service,
          testService: new WebhookTestEventService(testEvents, encryption),
          ingress: {
            database: ingressDatabase,
            testEvents,
            encryption,
            checkpointFactory: (projection) =>
              createInitialCheckpoint(projection, { catalog }),
            logger,
          },
          close: () => Promise.resolve(),
        },
        logger,
        telemetry,
      }),
      (value) => value.close(),
    );
    await application.listen(0, '127.0.0.1');
    const address = application.getHttpServer().address();
    if (address === null || typeof address === 'string')
      throw new Error('Webhook HTTP listener address is unavailable');
    origin = `http://127.0.0.1:${String(address.port)}`;
    return resources;
  } catch (error: unknown) {
    return rethrowFixtureSetupFailure(resources, error);
  }
}

export async function prepareDirectWebhookHTTPIntegrationFixture() {
  fixtureOwner = await createFixture();
}

export async function closeDirectWebhookHTTPIntegrationFixture() {
  await fixtureOwner?.close();
}

import type { ApiIdentityConfig } from '../../../../src/platform/config/identity.js';
import { captureLocalAuthenticationMail } from '../mail-capture.js';
import { randomUUID } from 'node:crypto';
import {
  createWorkspaceDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  type WorkspaceDatabase,
} from '@pertexo/database/testing';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';

import { createApiConnectionRuntime } from '../../../../src/platform/connections/runtime.module.js';
import { createApiIdentityRuntime } from '../../../../src/platform/identity/runtime.module.js';
import { FixtureResourceOwner } from '../../../browser/harness/resource-owner.js';
import { dropDisconnectedDatabase } from '../../disposable-database.js';
import { createFixtureConnectionRuntime } from '../../connection-runtime.js';
import { createBetterAuthFixtureApplication } from '../fixture-application.js';

import { createApiNotificationRuntime } from '../../../../src/platform/notifications/runtime.module.js';
import {
  adminUrl,
  migrationBaseUrl,
  apiBaseUrl,
  origin,
  password,
  silent,
  telemetry,
} from './environment.js';
import type {
  Browser,
  Application,
  Reply,
  SendInput,
  DatabaseCleanupFailure,
  ApiFixtureOptions,
} from './contract.js';
import { databaseCleanupFailure } from './cleanup.js';
import {
  apiConfig,
  fixtureIdentityConfiguration,
  fixtureApiConfiguration,
} from './configuration.js';
import { browserFrom } from './cookies.js';

/**
 * Creates and migrates a disposable database, boots the API on it and drops
 * the database afterwards. Requests use distinct client addresses; the
 * application fixture scopes real Redis rate-limit counters per instance.
 */
export function useBetterAuthRealApi(
  suite: string,
  options: ApiFixtureOptions = {},
) {
  const fixtureOrigin = options.publicWebOrigin ?? origin;
  const owner = new FixtureResourceOwner();
  let disposableDatabase: object | undefined;
  let databaseCleanupLabel: DatabaseCleanupFailure | undefined;
  const databaseName = `${options.databaseNamespace === undefined ? `pertexo_test_ba_${suite}` : 'pertexo_test_f07_organization'}_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = (base: string) => {
    const parsed = new URL(base);
    parsed.pathname = `/${databaseName}`;
    return parsed.toString();
  };
  const databaseConfig = parseDatabaseConfig({
    connectionString: databaseUrl(apiBaseUrl),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: options.databasePoolMax ?? 4,
    ownerRole: 'pertexo_owner',
  });
  const { mail, mailedMessages } = captureLocalAuthenticationMail();
  let application: Application;
  let workspaceDatabase: WorkspaceDatabase | undefined;
  let identityRuntime:
    Awaited<ReturnType<typeof createApiIdentityRuntime>> | undefined;
  let admin: Pool;
  let identityConfiguration: ApiIdentityConfig | undefined;
  let address = 0;

  beforeAll(async () => {
    const creator = owner.acquire(
      'database creator',
      new Pool({ connectionString: adminUrl, max: 1 }),
      (pool) => pool.end(),
    );
    await creator.query(
      `create database "${databaseName}" owner pertexo_owner`,
    );
    disposableDatabase = owner.acquire('disposable database', {}, async () => {
      try {
        const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
        try {
          await dropDisconnectedDatabase(cleanup, databaseName, {
            ...(options.beforeDrop === undefined
              ? {}
              : { beforeDrop: options.beforeDrop }),
          });
        } finally {
          await cleanup.end();
        }
      } catch (error: unknown) {
        databaseCleanupLabel = databaseCleanupFailure(error);
        throw error;
      }
    });
    await creator.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_maintenance`,
    );
    await migrateDatabase({
      appRole: 'pertexo_app',
      connectionString: databaseUrl(migrationBaseUrl),
      maintenanceRole: 'pertexo_maintenance',
      ownerRole: 'pertexo_owner',
    });
    admin = owner.acquire(
      'inspection pool',
      new Pool({ connectionString: databaseUrl(adminUrl), max: 1 }),
      (pool) => pool.end(),
    );
    await options.afterMigration?.(databaseUrl);
    const defaults = apiConfig(databaseConfig);
    if (defaults.identity === undefined) throw new Error('Identity is missing');
    const identity = fixtureIdentityConfiguration(
      defaults.identity,
      options,
      fixtureOrigin,
    );
    identityConfiguration = identity;
    const config = fixtureApiConfiguration(defaults, identity, options);
    identityRuntime = owner.acquire(
      'identity runtime',
      await createApiIdentityRuntime(identity, databaseConfig, {
        authenticationMail: options.authenticationMail?.(mail) ?? mail,
      }),
      (runtime) => runtime.close(),
    );
    workspaceDatabase = owner.acquire(
      'workspace database',
      createWorkspaceDatabase(databaseConfig),
      (database) => database.close(),
    );
    const webhookRuntime =
      options.webhookRuntime === undefined
        ? undefined
        : owner.acquire(
            'webhook runtime',
            await options.webhookRuntime(config),
            (runtime) => runtime.close(),
          );
    const notificationRuntime =
      options.notifications === true
        ? owner.acquire(
            'notification runtime',
            createApiNotificationRuntime(databaseConfig, config.redisUrl, {
              runtime: undefined,
              mail: options.notificationMail,
            }),
            (runtime) => runtime.close(),
          )
        : undefined;
    const connectionRuntime =
      options.connections === undefined
        ? undefined
        : owner.acquire(
            'connection runtime',
            options.connections.services === undefined
              ? await createApiConnectionRuntime(
                  options.connections.config,
                  databaseConfig,
                  {
                    identityRuntime,
                    applicationSecret: identity.betterAuth.secret,
                  },
                )
              : createFixtureConnectionRuntime(databaseConfig, {
                  identityRuntime,
                  applicationSecret: identity.betterAuth.secret,
                  services: options.connections.services(),
                }),
            (runtime) => runtime.close(),
          );
    application = await createBetterAuthFixtureApplication({
      config: config,
      dependencies: {
        database: workspaceDatabase,
        identityRuntime,
        logger: options.logger ?? silent,
        telemetry,
        ...(webhookRuntime === undefined ? {} : { webhookRuntime }),
        ...(notificationRuntime === undefined ? {} : { notificationRuntime }),
        ...(connectionRuntime === undefined ? {} : { connectionRuntime }),
      },
      owner: owner,
      schedules: options.schedules,
    });
    if (connectionRuntime !== undefined) owner.transfer(connectionRuntime);
    if (webhookRuntime !== undefined) owner.transfer(webhookRuntime);
    if (notificationRuntime !== undefined) owner.transfer(notificationRuntime);
    await application.init();
  }, 60_000);

  afterAll(async () => {
    const report = { otherCleanupFailed: false };
    await Promise.resolve()
      .then(() => options.beforeClose?.())
      .catch(() => {
        // A caller could not confirm that its external clients stopped. Close
        // our listeners/pools, but do not drop the database under those clients.
        if (disposableDatabase !== undefined)
          owner.transfer(disposableDatabase);
        report.otherCleanupFailed = true;
      });
    await owner.close().catch((error: unknown) => {
      // This is the unchanged owner's aggregate, not arbitrary resource data.
      if (
        databaseCleanupLabel === undefined ||
        !(error instanceof AggregateError) ||
        error.errors.length > 1
      )
        report.otherCleanupFailed = true;
    });
    const labels = [
      ...(databaseCleanupLabel === undefined ? [] : [databaseCleanupLabel]),
      ...(report.otherCleanupFailed ? ['other_cleanup_failure'] : []),
    ];
    // Vitest serializes nested errors, including their causes and properties.
    // Keep originals inside the owner; only a fresh safe report crosses this boundary.
    if (labels.length > 0)
      throw new Error(
        `Better Auth fixture cleanup failed: ${labels.join(', ')}`,
      );
  });

  function send(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    input: SendInput = {},
  ): Promise<Reply> {
    address += 1;
    return application.inject({
      method,
      url,
      remoteAddress:
        input.remoteAddress ?? `203.0.113.${String(address % 250)}`,
      headers: {
        origin: fixtureOrigin,
        ...(input.browser === undefined
          ? {}
          : {
              cookie: input.browser.cookie,
              'x-csrf-token': input.browser.csrf,
            }),
        ...input.headers,
      },
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    });
  }

  /** The newest link of one purpose mailed to an address. */
  function mailedLink(email: string, purpose: string): URL {
    const message = mailedMessages(email)
      .filter((item) => item.purpose === purpose)
      .at(-1);
    if (message === undefined) throw new Error(`No ${purpose} mail`);
    return new URL(message.url);
  }

  /** Signs up and follows the verification link to its landing page. */
  async function signUp(email: string, callbackURL: string) {
    const created = await send('POST', '/v1/auth/sign-up/email', {
      payload: { name: 'New Person', email, password, callbackURL },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const link = mailedLink(email, 'verification');
    const verified = await send('GET', link.pathname + link.search);
    expect(verified.statusCode).toBe(302);
    return { link, landing: new URL(String(verified.headers.location)) };
  }

  async function signIn(email: string): Promise<Browser> {
    const signedIn = await send('POST', '/v1/auth/sign-in/email', {
      payload: { email, password, callbackURL: '/workspaces' },
    });
    expect(signedIn.statusCode, signedIn.payload).toBe(200);
    return browserFrom(signedIn);
  }

  /** The superuser pool on the disposable database, for inspection. */
  function database(): Pool {
    return admin;
  }

  async function listen(): Promise<string> {
    await application.listen(0, '127.0.0.1');
    return application.getUrl();
  }

  async function createIdentityPeer(
    encryption: ApiIdentityConfig['federationEncryption'],
  ) {
    if (identityConfiguration === undefined)
      throw new Error('Identity fixture is not ready');
    const { federationEncryption: _, ...base } = identityConfiguration;
    const peer = await createApiIdentityRuntime(
      {
        ...base,
        ...(encryption === undefined
          ? {}
          : { federationEncryption: encryption }),
      },
      databaseConfig,
      { authenticationMail: mail },
    );
    return owner.acquire('peer identity runtime', peer, (runtime) =>
      runtime.close(),
    );
  }
  function identity() {
    if (identityRuntime === undefined)
      throw new Error('Identity fixture is not ready');
    return identityRuntime;
  }
  return {
    send,
    signUp,
    signIn,
    mailedLink,
    mailedMessages,
    database,
    listen,
    createIdentityPeer,
    identity,
  };
}

import type { AuthenticationMail } from '../../../../src/authentication/mail/delivery.js';

import type { ApiIdentityConfig } from '../../../../src/platform/config/identity.js';

import type { StructuredLogger } from '@pertexo/observability';

import type { createApiApplication } from '../../../../src/app.js';
import type { ApiConfig } from '../../../../src/platform/config/api.js';

import type { FixtureConnectionServices } from '../../connection-runtime.js';
import type { ApiWebhookRuntime } from '../../../../src/platform/webhooks/runtime.module.js';

export type Browser = Readonly<{
  session: string;
  csrf: string;
  cookie: string;
}>;

export type Application = Awaited<ReturnType<typeof createApiApplication>>;

export type Reply = Awaited<ReturnType<Application['inject']>>;

export type SendInput = Readonly<{
  browser?: Browser;
  headers?: Record<string, string>;
  payload?: object | string;
}>;

export type DatabaseCleanupFailure =
  | 'database_connection_probe_deadline'
  | 'database_poll_wait_deadline'
  | 'database_drop_deadline'
  | 'database_query_deadline'
  | 'database_query_read_timeout'
  | 'database_cleanup_failure';

export type ApiFixtureOptions = Readonly<{
  publicWebOrigin?: string;
  databasePoolMax?: number;
  authenticationMail?: (local: AuthenticationMail) => AuthenticationMail;
  automationTokens?: boolean;
  callbacks?: ApiConfig['callbacks'];
  artifacts?: ApiConfig['artifacts'];
  /** F07-owned qualification namespace, never a shared database selection. */
  databaseNamespace?: 'f07_organization';
  redisUrl?: string;
  schedules?: boolean;
  /** Compose the real workspace inbox runtime (ADR 055). */
  notifications?: boolean;
  notificationMail?: ApiIdentityConfig['betterAuth']['durableMail'];
  federationEncryption?: ApiIdentityConfig['federationEncryption'];
  secureCookies?: boolean;
  socialProviders?: ApiIdentityConfig['betterAuth']['providers'];
  webhookRuntime?: (config: ApiConfig) => Promise<ApiWebhookRuntime>;
  logger?: StructuredLogger;
  connections?: Readonly<{
    config: NonNullable<ApiConfig['connections']>;
    /** Replaces KMS and the providers; left out, the real runtime is used. */
    services?: () => FixtureConnectionServices;
  }>;
  afterMigration?: (databaseUrl: (base: string) => string) => Promise<void>;
  beforeClose?: () => Promise<void>;
  beforeDrop?: () => Promise<void>;
}>;

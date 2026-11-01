import {
  createNoticePreferencesStore,
  createWorkspaceInboxStore,
} from '@pertexo/core/inbox';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import type { ApiIdentityConfig } from '../config/identity.js';
import { NoticePreferencesService } from '../../notifications/preferences/service.js';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';

import {
  RedisInboxHintHub,
  type InboxHintSource,
} from '../../notifications/inbox-hint-hub.js';
import { WorkspaceInboxService } from '../../notifications/service.js';

/** ADR 055: the inbox's store and its per-process hint hub. */
export type ApiNotificationRuntime = Readonly<{
  service: WorkspaceInboxService;
  preferences?: NoticePreferencesService;
  hints: InboxHintSource;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

export function createApiNotificationRuntime(
  config: DatabaseConfig,
  redisUrl: string,
  {
    runtime,
    mail,
  }: Readonly<{
    runtime?: DatabaseRuntime | undefined;
    mail?: ApiIdentityConfig['betterAuth']['durableMail'] | undefined;
  }> = {},
): ApiNotificationRuntime {
  const store = createWorkspaceInboxStore(config, runtime);
  let hints: InboxHintSource;
  try {
    hints = new RedisInboxHintHub({ redisUrl });
  } catch (error: unknown) {
    void store.close().catch(() => undefined);
    throw error;
  }
  const preferences = createNoticePreferencesStore(config, {
    emailAvailable: mail !== undefined,
    runtime,
  });
  const preferenceService = new NoticePreferencesService(
    preferences,
    mail === undefined
      ? undefined
      : createApplicationSecretEnvelope(mail.encryption),
  );
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    service: new WorkspaceInboxService(store),
    preferences: preferenceService,
    hints,
    checkReadiness: () => hints.checkReadiness(),
    close: () => {
      closePromise ??= (async () => {
        const closed = await Promise.allSettled([
          hints.close(),
          store.close(),
          preferences.close(),
        ]);
        const failures = closed.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            'Notification runtime shutdown failed',
          );
      })();
      return closePromise;
    },
  });
}

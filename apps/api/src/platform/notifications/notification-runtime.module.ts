import {
  createWorkspaceInboxDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkspaceInboxDatabase,
} from '@pertexo/database/api';

import {
  RedisInboxHintHub,
  type InboxHintSource,
} from '../../notifications/inbox-hint-hub.js';
import { WorkspaceInboxService } from '../../notifications/service.js';

/** ADR 055: the inbox's database reader and its per-process hint hub. */
export type ApiNotificationRuntime = Readonly<{
  service: WorkspaceInboxService;
  hints: InboxHintSource;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

export type ApiNotificationRuntimeOverrides = Readonly<{
  database?: WorkspaceInboxDatabase;
  hints?: InboxHintSource;
}>;

export function createApiNotificationRuntime(
  config: DatabaseConfig,
  redisUrl: string,
  overrides: ApiNotificationRuntimeOverrides = {},
  runtime?: DatabaseRuntime,
): ApiNotificationRuntime {
  const database =
    overrides.database ?? createWorkspaceInboxDatabase(config, runtime);
  let hints: InboxHintSource;
  try {
    hints = overrides.hints ?? new RedisInboxHintHub({ redisUrl });
  } catch (error: unknown) {
    void database.close().catch(() => undefined);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    service: new WorkspaceInboxService(database),
    hints,
    checkReadiness: () => hints.checkReadiness(),
    close: () => {
      closePromise ??= (async () => {
        const closed = await Promise.allSettled([
          hints.close(),
          database.close(),
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

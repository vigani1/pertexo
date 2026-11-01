import { afterAll, beforeAll } from 'vitest';

import { createWorkspaceInboxFoldStore } from '../../../src/inbox/folding/store.js';
import { createWorkspaceInboxStore } from '../../../src/inbox/threads/store.js';
import {
  claim,
  complete,
  failedRun,
  fence,
  load,
  type Alert,
} from '../../notifications/rotation.support.js';
import {
  actorId,
  apiBaseUrl,
  asAdmin,
  databaseName,
  databaseUrl,
  namedDatabaseUrl,
  parseDatabaseConfig,
  workspaceA,
} from '../../runs/run-store/fixtures.js';
import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
} from '../../runs/run-store/scheduling/fixture.js';

export const owner = { workspaceId: workspaceA, actorId };
export const appConfig = () =>
  parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 2 });
export const maintenanceConfig = () =>
  parseDatabaseConfig({
    connectionString: namedDatabaseUrl(
      process.env.DATABASE_MAINTENANCE_URL ??
        'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
      databaseName,
    ),
    max: 1,
  });

export let reader: ReturnType<typeof createWorkspaceInboxStore>;
let scanner: ReturnType<typeof createWorkspaceInboxFoldStore>;
beforeAll(() => {
  reader = createWorkspaceInboxStore(appConfig());
  scanner = createWorkspaceInboxFoldStore(
    appConfig(),
    undefined,
    maintenanceConfig(),
  );
});
afterAll(async () => {
  await Promise.all([reader.close(), scanner.close()]);
});

/** Enough whole walks that a notice about to change has changed. */
export async function scan(walks = 3) {
  for (let walk = 0; walk < walks; walk += 1) await scanner.observeCurrent?.();
}

export async function noticeOf(destinationId: string) {
  const { items } = await reader.listThreads({
    ...owner,
    filter: 'all',
    noticeKind: 'failure_alert_attention',
    limit: 100,
  });
  return items.find(
    (item) => 'subjectId' in item && item.subjectId === destinationId,
  );
}

export async function raisedNotice(destinationId: string) {
  await scan();
  const notice = await noticeOf(destinationId);
  if (notice === undefined) throw new Error('Expected the notice');
  return notice;
}

export async function deadLetter(alert: Alert) {
  const { attemptNumber } = await claim(alert);
  await complete(alert, attemptNumber, {
    kind: 'definite_failure',
    safeErrorCode: 'delivery.destination_unavailable',
    possiblyDispatched: false,
  });
}

export async function deliver(alert: Alert) {
  const { attemptNumber } = await claim(alert);
  await load(alert, attemptNumber);
  await fence(alert, attemptNumber);
  await complete(alert, attemptNumber, {
    kind: 'delivered',
    possiblyDispatched: true,
    providerReference: 'provider-reference',
  });
}

/** Another run through the same destination, failing in its own right. */
export async function anotherRun(alert: Alert): Promise<Alert> {
  const { runId } = await commitPinnedFailureNotificationRun({
    destinationId: alert.destinationId,
    secretVersionId: alert.pinnedSecretVersionId,
    sideEffectClass: alert.kind === 'email' ? 'idempotent_with_key' : 'unsafe',
  });
  const identity = await failureNotificationIdentity(runId);
  return {
    ...alert,
    intentId: identity.intent_id,
    firstDelivery: {
      outboxEventId: identity.outbox_id,
      payloadChecksum: identity.payload_checksum,
    },
  };
}

/** The failure and everything before it moved back, so only the failure's age differs. */
export const failedHoursAgo = (alert: Alert, hours: number) =>
  asAdmin(async (pool) => {
    await pool.query(
      `update app.failure_notification_destinations
          set updated_at=clock_timestamp()-make_interval(hours => $2+1)
        where id=$1`,
      [alert.destinationId, hours],
    );
    await pool.query(
      `update app.connection_secret_versions
          set created_at=clock_timestamp()-make_interval(hours => $2+1)
        where connection_id=$1`,
      [alert.connectionId, hours],
    );
    await pool.query(
      `update app.run_failure_notification_intents
          set completed_at=clock_timestamp()-make_interval(hours => $2)
        where id=$1`,
      [alert.intentId, hours],
    );
  });

export const healthChanged = (connectionId: string) =>
  asAdmin((pool) =>
    pool.query(
      `update app.connections
          set health_revision=health_revision+1,
              last_health_transition_at=clock_timestamp(),
              last_health_transition_source='rotation'
        where workspace_id=$1 and id=$2`,
      [workspaceA, connectionId],
    ),
  );

export async function failedAlert(kind: 'slack' | 'email' = 'slack') {
  const alert = await failedRun(kind);
  await deadLetter(alert);
  return alert;
}

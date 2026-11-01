import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkspaceInboxFoldStore } from '../../src/inbox/folding/store.js';
import { createWorkspaceInboxStore } from '../../src/inbox/threads/store.js';
import {
  claim,
  complete,
  failedRun,
  fence,
  load,
  rotateCredential,
  type Alert,
} from '../notifications/rotation.support.js';
import {
  actorId,
  apiBaseUrl,
  asAdmin,
  databaseName,
  databaseUrl,
  namedDatabaseUrl,
  parseDatabaseConfig,
  workspaceA,
} from '../runs/run-store/fixtures.js';

type Scope = Readonly<{ workspaceId: string; actorId: string }>;

// A real alert needs the run store's own database, so these stores use it too.
let reader: ReturnType<typeof createWorkspaceInboxStore>;
let scanner: ReturnType<typeof createWorkspaceInboxFoldStore>;
beforeAll(() => {
  const app = parseDatabaseConfig({
    connectionString: databaseUrl(apiBaseUrl),
    max: 2,
  });
  reader = createWorkspaceInboxStore(app);
  scanner = createWorkspaceInboxFoldStore(
    app,
    undefined,
    parseDatabaseConfig({
      connectionString: namedDatabaseUrl(
        process.env.DATABASE_MAINTENANCE_URL ??
          'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
        databaseName,
      ),
      max: 1,
    }),
  );
});
afterAll(async () => {
  await Promise.all([reader.close(), scanner.close()]);
});

/** The observer walks every workspace a page at a time, so give it enough turns. */
async function observeUntil(done: () => Promise<boolean>) {
  for (let scan = 0; scan < 40 && !(await done()); scan += 1)
    await scanner.observeCurrent?.();
}

async function noticeFor(scope: Scope, destinationId: string) {
  const { items } = await reader.listThreads({
    ...scope,
    filter: 'all',
    noticeKind: 'failure_alert_attention',
    limit: 100,
  });
  return items.find(
    (item) => 'subjectId' in item && item.subjectId === destinationId,
  );
}

async function deadLetter(alert: Alert) {
  const { attemptNumber } = await claim(alert);
  await complete(alert, attemptNumber, {
    kind: 'definite_failure',
    safeErrorCode: 'delivery.destination_unavailable',
    possiblyDispatched: false,
  });
}

describe('an alert that ended without arriving', () => {
  const owner = { workspaceId: workspaceA, actorId };

  it('raises a notice naming where alerts are not reaching, and fixing the destination clears it', async () => {
    const alert = await failedRun('slack');
    await deadLetter(alert);

    await observeUntil(
      async () => (await noticeFor(owner, alert.destinationId)) !== undefined,
    );
    expect(await noticeFor(owner, alert.destinationId)).toMatchObject({
      noticeKind: 'failure_alert_attention',
      name: 'Slack',
      workflowId: null,
      unread: true,
    });

    await rotateCredential(alert.connectionId);
    await observeUntil(
      async () => (await noticeFor(owner, alert.destinationId)) === undefined,
    );
    expect(await noticeFor(owner, alert.destinationId)).toBeUndefined();
  });

  it('stays one notice however many alerts have failed', async () => {
    const alert = await failedRun('slack');
    await deadLetter(alert);
    await observeUntil(
      async () => (await noticeFor(owner, alert.destinationId)) !== undefined,
    );
    const before = await noticeFor(owner, alert.destinationId);

    await scanner.observeCurrent?.();

    expect(await noticeFor(owner, alert.destinationId)).toEqual(before);
    const { rows } = await asAdmin((pool) =>
      pool.query(
        "select id from app.workspace_inbox_threads where workspace_id=$1 and notice_kind='failure_alert_attention' and subject_id=$2",
        [workspaceA, alert.destinationId],
      ),
    );
    expect(rows).toHaveLength(1);
  });

  it('does nothing for an alert that was delivered', async () => {
    const alert = await failedRun('slack');
    const { attemptNumber } = await claim(alert);
    await load(alert, attemptNumber);
    await fence(alert, attemptNumber);
    await complete(alert, attemptNumber, {
      kind: 'delivered',
      possiblyDispatched: true,
      providerReference: 'provider-reference',
    });
    for (let scan = 0; scan < 5; scan += 1) await scanner.observeCurrent?.();
    expect(await noticeFor(owner, alert.destinationId)).toBeUndefined();
  });
});

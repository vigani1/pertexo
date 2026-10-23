import { it, expect } from 'vitest';

import {
  FailureNotificationContextSchema,
  asRuntime,
  checkpoint,
  createTestRunStore,
  databaseUrl,
  insertRun,
  notificationSecretVersionId,
  parseDatabaseConfig,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  inboxEvents,
} from '../fixture.js';

export function registerRecordsOneWorkspaceInboxFailure(): void {
  it('records one workspace inbox failure', async () => {
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({ runStatus: 'running' }),
    });
    const inboxStore = createTestRunStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      delivery: await testDelivery(workspaceA, runId, 0),
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: checkpoint({
          revision: 1,
          runStatus: 'outcome_unknown',
          nextEventSequence: 3,
          invocations: [],
        }),
        events: [
          {
            sequence: 2,
            name: 'run.outcome_unknown' as const,
            occurredAt: '2026-09-28T10:01:00.000Z',
          },
        ],
        nodeRunAdmissions: [],
        attempts: [],
      },
    };
    try {
      await expect(inboxStore.commitAdvancePlan(input)).resolves.toMatchObject({
        kind: 'committed',
      });
      await expect(inboxStore.commitAdvancePlan(input)).resolves.toMatchObject({
        kind: 'already_committed',
      });
    } finally {
      await inboxStore.close();
    }
    await expect(inboxEvents(runId)).resolves.toEqual([
      {
        kind: 'outcome_unknown',
        terminal_event_sequence: '2',
        occurred_at: '2026-09-28T10:01:00.000Z',
      },
    ]);
  });

  it('atomically creates one policy-pinned safe failure notification intent', async () => {
    const { invocationKey, runId } = await commitPinnedFailureNotificationRun();
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        intent_count: number;
        outbox_count: number;
        context: Record<string, unknown>;
      }>(
        `select count(distinct intent.id)::int intent_count,
                  count(distinct outbox.id)::int outbox_count,
                  min(intent.context::text)::jsonb context
           from app.run_failure_notification_intents intent
           join app.outbox_events outbox on outbox.aggregate_id=intent.id
           where intent.workspace_id=$1 and intent.workflow_run_id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({ intent_count: 1, outbox_count: 1 });
    const persistedContext = FailureNotificationContextSchema.parse(
      proof.rows[0]?.context,
    );
    expect(persistedContext.terminalStatus).toBe('failed');
    expect(persistedContext.primaryFailure).toMatchObject({
      invocationKey,
      safeErrorCode: 'provider.unavailable',
    });
    expect(JSON.stringify(proof.rows[0]?.context)).not.toMatch(
      /errorSummary|secret|input|output|connection|actor/i,
    );
    const hidden = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `select id from app.run_failure_notification_intents where workflow_run_id=$1`,
        [runId],
      ),
    );
    expect(hidden.rowCount).toBe(0);

    const identity = await failureNotificationIdentity(runId);
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ matches_pin: boolean }>(
          `select intent.destination_config_version = 1
                    and intent.connection_secret_version_id = $2 as matches_pin
             from app.run_failure_notification_intents intent
             where intent.id=$1`,
          [identity.intent_id, notificationSecretVersionId],
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ matches_pin: true }] });
  });
}

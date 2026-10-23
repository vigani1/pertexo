import { it, expect } from 'vitest';
import {
  CoordinatorRunStateCorruptError,
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

import { measureObservationLoad } from './fixture.js';

export function registerFailsClosedEventGapsCorrupt(): void {
  it('fails closed for event gaps and corrupt physical event identities', async () => {
    const gapRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,3,'run.cancel_requested','{}')`,
        [workspaceA, gapRun],
      ),
    );
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: gapRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const corruptRun = await insertRun({
      schedulerState: checkpoint({ runStatus: 'running' }),
      status: 'running',
    });
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.started',$3::jsonb)`,
        [
          workspaceA,
          corruptRun,
          JSON.stringify({
            nodeRunId: randomUUID(),
            attemptId: randomUUID(),
          }),
        ],
      ),
    );
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: corruptRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('rejects oversized persisted facts without materializing an oversized batch', async () => {
    const oversizedRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'run.cancel_requested',
             jsonb_build_object('ignored',repeat('x',100000)))`,
        [workspaceA, oversizedRun],
      ),
    );
    await expect(
      measureObservationLoad('application_oversized', () =>
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId: oversizedRun,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: oversizedRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 4,
          }),
          events: [
            {
              sequence: 3,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('rejects a large wire population at the canonical per-fact guard', async () => {
    const aggregateRun = await insertRun({});
    const storageBytes = await asRuntime(
      workerBaseUrl,
      workspaceA,
      async (client) => {
        await client.query(
          `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           select $1,$2,sequence,'run.cancel_requested',
                  jsonb_build_object(
                    'ignored',repeat('x',520000)
                  )
           from generate_series(2,131) sequence`,
          [workspaceA, aggregateRun],
        );
        const size = await client.query<{ bytes: string }>(
          `select sum(octet_length(payload::text))::bigint bytes
           from app.run_events
           where workspace_id=$1 and workflow_run_id=$2 and sequence >= 2`,
          [workspaceA, aggregateRun],
        );
        return Number(size.rows[0]?.bytes);
      },
    );
    expect(storageBytes).toBeGreaterThan(64 * 1024 * 1024);
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: aggregateRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: aggregateRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 131,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 133,
          }),
          events: [
            {
              sequence: 132,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('fails closed on malformed legacy event identities before UUID joins', async () => {
    const malformedRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.started',$3::jsonb)`,
        [
          workspaceA,
          malformedRun,
          JSON.stringify({
            nodeRunId: 'not-a-uuid',
            attemptId: 'also-not-a-uuid',
          }),
        ],
      ),
    );

    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: malformedRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });
}

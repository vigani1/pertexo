import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  insertRun,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

export function registerAtomicallyCommitsExactEventsAll(): void {
  it('atomically commits exact events, all logical rows, an attempt subset, and IDs-only outbox', async () => {
    const runId = await insertRun({});
    const invocationA = 'version-a/a';
    const invocationB = 'version-a/b';
    const next = checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 5,
      readySet: [invocationB],
      admittedInvocationKeys: [invocationA],
      invocations: [
        {
          invocationKey: invocationA,
          nodeId: 'a',
          status: 'running',
          attemptNumber: 1,
        },
        {
          invocationKey: invocationB,
          nodeId: 'b',
          status: 'ready',
          attemptNumber: 0,
        },
      ],
    });
    const result = await ownedDeliveryStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: next,
        events: [
          {
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey: invocationA,
            nodeId: 'a',
            attemptNumber: 0,
          },
          {
            sequence: 4,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey: invocationB,
            nodeId: 'b',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey: invocationA, nodeId: 'a', sideEffectClass: 'safe' },
          { invocationKey: invocationB, nodeId: 'b', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            invocationKey: invocationA,
            nodeId: 'a',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    expect(result).toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        event_sequences: number[];
        node_count: number;
        attempt_count: number;
        outbox_count: number;
        payload_keys: string[];
        engine_node_events_valid: boolean;
      }>(
        `select
             (select array_agg(sequence order by sequence) from app.run_events where workflow_run_id=$1) event_sequences,
             (select count(*)::int from app.node_runs where workflow_run_id=$1) node_count,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempt_count,
             (select count(*)::int from app.outbox_events where job_name='execute-node-attempt' and payload->>'runId'=$1::text) outbox_count,
             (select array_agg(key order by key) from app.outbox_events, lateral jsonb_object_keys(payload) key where job_name='execute-node-attempt' and payload->>'runId'=$1::text) payload_keys,
             (select count(*)=2 and bool_and(
                jsonb_typeof(payload)='object'
                and payload->>'invocationKey' in ($2,$3)
                and payload->>'nodeId' in ('a','b')
                and (payload->>'attemptNumber')::int =
                  0
                and payload ? 'nodeRunId'
                and not (payload ? 'attemptId')
              ) from app.run_events
              where workflow_run_id=$1 and type='node.ready') engine_node_events_valid`,
        [runId, invocationA, invocationB],
      ),
    );
    expect(proof.rows[0]).toEqual({
      event_sequences: [1, 2, 3, 4],
      node_count: 2,
      attempt_count: 1,
      outbox_count: 1,
      payload_keys: [
        'attemptId',
        'nodeRunId',
        'outboxEventId',
        'runId',
        'workspaceId',
      ],
      engine_node_events_valid: true,
    });
  });
}

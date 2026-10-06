import { describe, expect, it } from 'vitest';

import {
  actorId,
  asOwner,
  insertRun,
  randomUUID,
  rawStore,
  retainedRunId,
  testDelivery,
  asRuntime,
  workerBaseUrl,
  workflowA,
  workspaceA,
  workspaceB,
} from './coordinator-run-store.fixtures.js';

const signal = () => new AbortController().signal;

describe('coordinator executable classification through the real tenant store', () => {
  it('acknowledges a canonical delivery once and audits checksum substitution', async () => {
    const runId = await insertRun({});
    const delivery = await testDelivery(workspaceA, runId, 0);
    const input = {
      workspaceId: workspaceA,
      runId,
      delivery,
      signal: signal(),
    };
    await expect(rawStore.acknowledgeAdvanceDelivery(input)).resolves.toEqual({
      kind: 'acknowledged',
    });
    await expect(rawStore.acknowledgeAdvanceDelivery(input)).resolves.toEqual({
      kind: 'duplicate',
    });
    await expect(
      rawStore.acknowledgeAdvanceDelivery({
        ...input,
        delivery: { ...delivery, payloadChecksum: 'f'.repeat(64) },
      }),
    ).rejects.toMatchObject({ name: 'CoordinatorDeliveryMismatchError' });
    const audit = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ fact_type: string }>(
        'select fact_type from app.transport_security_audit_facts where workspace_id=$1 and message_id=$2',
        [workspaceA, delivery.outboxEventId],
      ),
    );
    expect(audit.rows).toEqual([{ fact_type: 'inbox_checksum_mismatch' }]);
  });

  it('distinguishes an existing retained orphan from missing and foreign runs', async () => {
    // This run was persisted at 0014 and migrated normally. Its immutable
    // version never existed: a LEFT JOIN must retain its run identity without
    // treating null version metadata as executable authority.
    await expect(
      rawStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: retainedRunId,
        signal: signal(),
      }),
    ).resolves.toEqual({ kind: 'not_executable' });
    for (const [workspaceId, runId] of [
      [workspaceA, randomUUID()],
      [workspaceB, retainedRunId],
    ] as const) {
      await expect(
        rawStore.loadAdvanceState({
          workspaceId,
          runId,
          signal: signal(),
        }),
      ).resolves.toEqual({ kind: 'not_found' });
    }
  });

  it('retains the supported V2 public observation contract', async () => {
    const runId = await insertRun({});
    await expect(
      rawStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      kind: 'ready',
      state: { runId, checkpoint: { schemaVersion: 1 } },
    });
  });

  it.each([false, true])(
    'refuses actual V3 metadata in a retained-only consumer (valid checkpoint=%s)',
    async (validCheckpoint) => {
      const versionId = randomUUID();
      await asOwner(workspaceA, (client) =>
        client.query(
          `insert into app.workflow_versions(
        id,workspace_id,workflow_id,version_number,schema_version,graph_json,
        checksum,executable_schema_version,executable_json,compatibility_release_epoch,published_by
      ) values($1,$2,$3,$4,2,'{"schemaVersion":2}',$5,3,$6,1,$7)`,
          [
            versionId,
            workspaceA,
            workflowA,
            validCheckpoint ? 101 : 102,
            `wf:v3:sha256:${(validCheckpoint ? 'a' : 'b').repeat(64)}`,
            { schemaVersion: 3, graph: { nodes: [], edges: [] } },
            actorId,
          ],
        ),
      );
      const runId = await insertRun({
        workflowVersionId: versionId,
        schedulerState: validCheckpoint
          ? {
              schemaVersion: 3,
              engineVersion: 'engine-v1',
              workflowVersionId: versionId,
              revision: 0,
              runStatus: 'queued',
              nextEventSequence: 2,
              readySet: [],
              admittedInvocationKeys: [],
              invocations: [],
              joins: [],
              loops: [],
              calls: [],
              branchSelections: [],
              remainingIterationBudget: 0,
              cancelRequested: false,
              deadlineExpired: false,
            }
          : { schemaVersion: 3, corrupt: true },
      });
      // No native delivery is supplied. Classification must refuse before it
      // validates a native delivery or parses even the deliberately corrupt CP3.
      await expect(
        rawStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: signal(),
        }),
      ).resolves.toEqual({ kind: 'not_executable' });
      await expect(
        rawStore.loadAdvanceState({
          workspaceId: workspaceB,
          runId,
          signal: signal(),
        }),
      ).resolves.toEqual({ kind: 'not_found' });
    },
  );
});

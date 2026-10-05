import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { advanceWorkflow } from '@pertexo/workflow-engine';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import {
  createNodeAttemptRunStore,
  serializeWorkflowExecutionJsonValueV3,
} from '../src/execution.js';
import {
  asRuntime,
  testDelivery,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from './coordinator-run-store.fixtures.js';
import {
  acceptNativeFixture,
  activateNativeFixture,
  createNativeCoordinatorFixtureStore as nativeStore,
  nativeStoreConfig,
} from './support/native-public-store.fixture.js';

beforeAll(activateNativeFixture, 60_000);
const signal = () => new AbortController().signal;
const literal = { kind: 'literal', value: { answer: 42 } } as const;

describe('native V3 public stores over real PostgreSQL', () => {
  it('admits the actual compiler release and binds native reads to tenant, revision and canonical delivery', async () => {
    const run = await acceptNativeFixture(literal);
    const store = nativeStore();
    try {
      expect(() =>
        store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: run.runId,
          delivery: run.delivery,
          signal: signal(),
        }),
      ).toThrow('owner readiness');
      await store.checkReadiness?.();
      await expect(
        store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: run.runId,
          delivery: run.delivery,
          signal: signal(),
        }),
      ).resolves.toMatchObject({
        kind: 'ready',
        state: {
          checkpoint: run.initialCheckpoint,
          observations: [],
          workflowCalls: { facts: [], declarations: [] },
        },
      });
      await expect(
        store.loadAdvanceState({
          workspaceId: workspaceB,
          runId: run.runId,
          delivery: run.delivery,
          signal: signal(),
        }),
      ).resolves.toEqual({ kind: 'not_found' });
      const owner = {
        workspaceId: workspaceA,
        runId: run.runId,
        workflowVersionId: run.versionId,
        delivery: run.delivery,
        expectedRevision: 0,
      };
      await expect(
        store.inspectCoordinatorValueReadOwner?.({
          owner,
          signal: signal(),
          readTimeoutMillis: 2000,
        }),
      ).resolves.toMatchObject({ kind: 'active' });
      await expect(
        store.inspectCoordinatorValueReadOwner?.({
          owner: { ...owner, expectedRevision: 1 },
          signal: signal(),
          readTimeoutMillis: 2000,
        }),
      ).resolves.toMatchObject({
        kind: 'stopped',
        stop: { kind: 'stale', revision: 0 },
      });
      await expect(
        store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: run.runId,
          delivery: { ...run.delivery, payloadChecksum: 'f'.repeat(64) },
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: run.runId,
          signal: signal(),
        }),
      ).rejects.toBeDefined();
    } finally {
      await store.close();
    }
  });

  it.each([
    literal,
    { kind: 'run_input', path: '$' },
    { kind: 'node_output', nodeId: 'manual', path: '$' },
  ] satisfies WorkflowCallableDeclarationV1['resultSelector'][])(
    'persists independently authenticated callable $kind result and original native bytes',
    async (selector) => {
      const run = await acceptNativeFixture(selector);
      const store = nativeStore();
      const attempts = createNodeAttemptRunStore(nativeStoreConfig);
      try {
        await store.checkReadiness?.();
        const initial = await store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: run.runId,
          delivery: run.delivery,
          signal: signal(),
        });
        if (initial.kind !== 'ready') throw new Error('Native root not ready');
        const first = await advanceWorkflow({
          runId: run.runId,
          workflowVersionId: run.versionId,
          executable: run.executable,
          checkpoint: initial.state.checkpoint,
          observations: initial.state.observations,
          occurredAt: new Date().toISOString(),
          maximumAdmissions: 10,
          signal: signal(),
        });
        const committed = await store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId: run.runId,
          workflowVersionId: run.versionId,
          delivery: run.delivery,
          plan: first,
          signal: signal(),
        });
        if (committed.kind !== 'committed')
          throw new Error('Native root admission not committed');
        expect(committed.admittedAttempts).toHaveLength(1);
        const admitted = committed.admittedAttempts[0];
        if (admitted === undefined)
          throw new Error('Native manual attempt missing');
        const deliveryRows = await asRuntime(
          workerBaseUrl,
          workspaceA,
          (client) =>
            client.query<{ id: string; payload_checksum: string }>(
              "select id,payload_checksum from app.outbox_events where workspace_id=$1 and job_name='execute-node-attempt' and payload->>'attemptId'=$2",
              [workspaceA, admitted.attemptId],
            ),
        );
        const attemptDelivery = deliveryRows.rows[0];
        if (attemptDelivery === undefined)
          throw new Error('Canonical attempt delivery missing');
        const claimed = await attempts.claimDelivery({
          workspaceId: workspaceA,
          runId: run.runId,
          nodeRunId: admitted.nodeRunId,
          attemptId: admitted.attemptId,
          delivery: {
            outboxEventId: attemptDelivery.id,
            payloadChecksum: attemptDelivery.payload_checksum,
          },
          leaseDurationSeconds: 30,
          workerId: 'native-public-store',
          signal: signal(),
        });
        if (claimed.kind !== 'claimed')
          throw new Error('Native attempt not claimed');
        const inputs = await attempts.loadInputs({
          lease: claimed.lease,
          upstreamNodeOutputs: [],
          signal: signal(),
        });
        expect(inputs.nativeValueSources?.runInput?.snapshot).toMatchObject({
          serializedValue: '{"answer":42}',
        });
        expect(inputs.runInput).toBeNull();
        const source = inputs.nativeValueSources?.runInput;
        if (
          source === undefined ||
          source === null ||
          attempts.readNativeValueSource === undefined
        )
          throw new Error('Native selected attempt source missing');
        await expect(
          attempts.readNativeValueSource({
            lease: claimed.lease,
            source,
            signal: signal(),
          }),
        ).resolves.toMatchObject({
          snapshot: { serializedValue: '{"answer":42}' },
        });
        await expect(
          attempts.readNativeValueSource({
            lease: { ...claimed.lease, attemptId: randomUUID() },
            source,
            signal: signal(),
          }),
        ).rejects.toBeDefined();
        const output = { answer: 42 };
        const original = serializeWorkflowExecutionJsonValueV3(output);
        const completed = await attempts.complete({
          lease: claimed.lease,
          outcome: { status: 'succeeded', output },
          nativeOutput: {
            reference: { schemaVersion: 1, kind: 'inline', value: output },
            sha256: createHash('sha256').update(original).digest('hex'),
            byteLength: Buffer.byteLength(original),
          },
          signal: signal(),
        });
        expect(completed.kind).toBe('committed');
        const delivery = await testDelivery(workspaceA, run.runId, 1);
        const loaded = await store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: run.runId,
          delivery,
          signal: signal(),
        });
        if (loaded.kind !== 'ready')
          throw new Error('Completed native attempt not observable');
        const completion = {
          runInput: output,
          outputs: [
            {
              invocationKey: admitted.invocationKey,
              output: { kind: 'inline', attemptId: admitted.attemptId },
              value: output,
            },
          ],
        };
        const terminal = await advanceWorkflow({
          runId: run.runId,
          workflowVersionId: run.versionId,
          executable: run.executable,
          checkpoint: loaded.state.checkpoint,
          observations: loaded.state.observations,
          callableCompletion: completion,
          occurredAt: new Date().toISOString(),
          maximumAdmissions: 10,
          signal: signal(),
        });
        expect(terminal.callableResult).toMatchObject({
          kind: 'succeeded',
          value: output,
        });
        await expect(
          store.commitAdvancePlan({
            workspaceId: workspaceA,
            runId: run.runId,
            workflowVersionId: run.versionId,
            delivery,
            plan: {
              ...terminal,
              callableResult: {
                ...terminal.callableResult,
                value: { answer: 43 },
              },
            },
            signal: signal(),
          }),
        ).rejects.toBeDefined();
        await expect(
          store.commitAdvancePlan({
            workspaceId: workspaceA,
            runId: run.runId,
            workflowVersionId: run.versionId,
            delivery,
            plan: terminal,
            signal: signal(),
          }),
        ).resolves.toMatchObject({ kind: 'committed', revision: 2 });
        const stored = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ status: string; result_ref: unknown }>(
            'select status,output_ref as result_ref from app.workflow_runs where workspace_id=$1 and id=$2',
            [workspaceA, run.runId],
          ),
        );
        expect(stored.rows).toEqual([
          {
            status: 'succeeded',
            result_ref: { schemaVersion: 1, kind: 'inline', value: output },
          },
        ]);
      } finally {
        await attempts.close();
        await store.close();
      }
    },
  );
});

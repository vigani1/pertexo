import { beforeAll, describe, expect, it } from 'vitest';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import {
  asAdmin,
  asRuntime,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';
import {
  acceptNativeFixture,
  activateNativeFixture,
  completeNativePhysical,
  createNativeCoordinatorFixtureStore,
  loadNativePlan,
} from './support/native-public-store.fixture.js';

async function setRollout(enabled: boolean) {
  await asAdmin(async (client) => {
    await client.query('begin');
    try {
      await client.query('set local role pertexo_operator');
      await client.query('select app.set_workflow_calls_enabled($1)', [
        enabled,
      ]);
      await client.query(
        'update app.workflow_input_case_rollout set enabled=true where singleton',
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}
beforeAll(async () => {
  await activateNativeFixture();
  await setRollout(true);
}, 60_000);

describe('native workflow Call through real public stores', () => {
  it('seals one canonical child and consumes its accepted result after OFF', async () => {
    const output = { answer: 42 };
    const template = await acceptNativeFixture({
      kind: 'literal',
      value: output,
    });
    const declaration = template.executable.envelope.graph.callable;
    if (declaration === undefined)
      throw new Error('Compiled child declaration missing');
    const parent = await acceptNativeFixture(
      { kind: 'node_output', nodeId: 'call', path: '$' },
      {
        workflowId: template.workflowId,
        versionId: template.versionId,
        checksum: template.executable.checksum,
        callableContractIdentity:
          workflowCallableContractIdentityV1(declaration),
      },
    );
    const store = createNativeCoordinatorFixtureStore();
    const callees = new Map([[template.versionId, declaration]]);
    try {
      await store.checkReadiness?.();
      const first = await loadNativePlan(parent, store, 0, undefined, callees);
      const manual = await first.commit();
      if (
        manual.kind !== 'committed' ||
        manual.admittedAttempts[0] === undefined
      )
        throw new Error('Parent manual admission missing');
      expect(
        (
          await completeNativePhysical(
            parent.runId,
            manual.admittedAttempts[0],
            output,
          )
        ).completed.kind,
      ).toBe('committed');
      const next = await loadNativePlan(parent, store, 1, undefined, callees);
      const call = await next.commit();
      if (call.kind !== 'committed' || call.admittedAttempts[0] === undefined)
        throw new Error('Physical Call admission missing');
      const physical = await completeNativePhysical(
        parent.runId,
        call.admittedAttempts[0],
        output,
        true,
      );
      expect(physical.read).toMatchObject({
        reference: { schemaVersion: 1, kind: 'inline', value: output },
        serializedValue: '{"answer":42}',
      });
      expect(physical.completed.kind).toBe('committed');
      const admission = await loadNativePlan(
        parent,
        store,
        2,
        undefined,
        callees,
      );
      expect(admission.plan.workflowCalls?.declarations).toHaveLength(1);
      await expect(admission.commit()).resolves.toMatchObject({
        kind: 'committed',
        revision: 3,
      });
      const observed = await loadNativePlan(
        parent,
        store,
        3,
        undefined,
        callees,
      );
      const fact = observed.state.workflowCalls?.facts[0];
      if (fact?.status !== 'admitted')
        throw new Error('Sealed canonical child identity missing');
      const child = {
        runId: fact.childRunId,
        versionId: template.versionId,
        executable: template.executable,
      };
      const lineage = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          trigger_type: string;
          workflow_version_id: string;
          input_ref: unknown;
        }>(
          'select trigger_type,workflow_version_id,input_ref from app.workflow_runs where workspace_id=$1 and id=$2',
          [workspaceA, child.runId],
        ),
      );
      expect(lineage.rows).toEqual([
        {
          trigger_type: 'workflow_call',
          workflow_version_id: template.versionId,
          input_ref: { schemaVersion: 1, kind: 'inline', value: output },
        },
      ]);
      await setRollout(false);
      const childInitial = await loadNativePlan(child, store, 0);
      const childAdmitted = await childInitial.commit();
      if (
        childAdmitted.kind !== 'committed' ||
        childAdmitted.admittedAttempts[0] === undefined
      )
        throw new Error('Child manual admission missing');
      expect(
        (
          await completeNativePhysical(
            child.runId,
            childAdmitted.admittedAttempts[0],
            output,
          )
        ).completed.kind,
      ).toBe('committed');
      const childTerminal = await loadNativePlan(child, store, 1, {
        runInput: output,
        outputs: [],
      });
      await expect(childTerminal.commit()).resolves.toMatchObject({
        kind: 'committed',
        revision: 2,
      });
      // The previously accepted edge, not current publication or rollout, owns
      // its result. This is active-parent consumption, not terminal replay.
      const parentTerminal = await loadNativePlan(
        parent,
        store,
        3,
        {
          runInput: output,
          outputs: [
            {
              invocationKey: fact.invocationKey,
              output: {
                kind: 'workflow_call',
                invocationKey: fact.invocationKey,
                childRunId: child.runId,
              },
              value: output,
            },
          ],
        },
        callees,
      );
      expect(parentTerminal.state.workflowCalls?.facts[0]).toMatchObject({
        status: 'settled',
        childStatus: 'succeeded',
        childRunId: child.runId,
      });
      expect(parentTerminal.plan.callableResult).toMatchObject({
        kind: 'succeeded',
        value: output,
      });
      await expect(parentTerminal.commit()).resolves.toMatchObject({
        kind: 'committed',
        revision: 4,
      });
      const rows = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          'select count(*)::int count from app.workflow_runs where workspace_id=$1 and trigger_type=$2 and workflow_version_id=$3',
          [workspaceA, 'workflow_call', template.versionId],
        ),
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
    } finally {
      await store.close();
      await setRollout(true);
    }
  });
});

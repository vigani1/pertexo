import { NODE_ATTEMPT_INPUT_LIMITS } from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';
import {
  asAdmin,
  insertRun,
  nodeAttemptStore,
  randomUUID,
  versionA,
  workspaceA,
} from './fixtures.js';
import { claimDispatchAttempt } from './node-attempts/fixture.js';

async function saveOutputs(
  runId: string,
  nodeIds: readonly string[],
  offset: number,
) {
  await asAdmin((client) =>
    client.query(
      `with data as (
    select gen_random_uuid() node_id,gen_random_uuid() attempt_id,node_name,ordinal,
      jsonb_build_object('kind','inline','value',jsonb_build_object('index',ordinal+$4::int)) output
    from unnest($3::text[]) with ordinality as listed(node_name,ordinal)
  ), nodes as (
    insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,current_attempt_id,current_attempt_number,output_ref)
    select node_id,$1,$2,node_name,$5||'|'||node_name||'|b:|i:','{}','succeeded','safe',attempt_id,1,output from data returning id
  ) insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref)
    select attempt_id,$1,node_id,1,'succeeded','safe',output from data join nodes on nodes.id=data.node_id`,
      [workspaceA, runId, nodeIds, offset, versionA],
    ),
  );
}

describe('persisted upstream input populations', () => {
  it.each([
    1,
    Math.ceil(NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs / 2),
    NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs,
  ])(
    'returns exactly %i requested outputs despite retained and overlapping foreign rows',
    async (population) => {
      const lease = await claimDispatchAttempt(`consumer-${randomUUID()}`, {
        sideEffectClass: 'safe',
      });
      const nodeIds = Array.from(
        { length: population },
        (_, index) => `upstream-${String(index)}`,
      );
      await saveOutputs(lease.runId, nodeIds, 0);
      await saveOutputs(
        lease.runId,
        Array.from(
          { length: 2_000 },
          (_, index) => `retained-${String(index)}`,
        ),
        10_000,
      );
      const foreignRun = await insertRun({});
      await saveOutputs(foreignRun, nodeIds, 20_000);
      const upstreamNodeOutputs = nodeIds.map((nodeId) => ({
        nodeId,
        invocationKey: `${versionA}|${nodeId}|b:|i:`,
      }));
      const started = performance.now();
      const result = await nodeAttemptStore.loadInputs({
        lease,
        upstreamNodeOutputs,
        signal: new AbortController().signal,
      });
      expect(result.completedNodeOutputs).toEqual(
        upstreamNodeOutputs.map((identity, index) => ({
          ...identity,
          value: { index: index + 1 },
        })),
      );
      console.info(
        `UPSTREAM_POSTGRES=${JSON.stringify({ population, retainedRows: 2_000, foreignRows: population, operationMs: performance.now() - started })}`,
      );
    },
  );
});

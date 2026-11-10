import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  publicId,
  publicRun,
} from './folders/fixture.js';
import { queryAsOwner, workspaceId } from '../../support/workflow-authoring.js';

beforeAll(beforeAllFixture1, 30_000);
afterAll(afterAllFixture2);

interface Plan {
  'Actual Rows': number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: Plan[];
}

it('reads recent ordinary runs without traversing newer test history', async () => {
  await queryAsOwner(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,input_ref,input_ref_expires_at)
    select gen_random_uuid(),workspace_id,workflow_id,workflow_version_id,'test','succeeded',clock_timestamp()+i*interval '1 millisecond',input_ref,input_ref_expires_at
    from app.workflow_runs cross join generate_series(1,1000) i where id=$1`,
    [publicRun],
    workspaceId,
  );
  await queryAsOwner('analyze app.workflow_runs');
  const result = await queryAsOwner<{ 'QUERY PLAN': { Plan: Plan }[] }>(
    `explain (analyze,buffers,format json)
    select status,created_at from app.workflow_runs
    where workspace_id=$1 and workflow_id=$2 and trigger_type<>'test'
    order by created_at desc,id desc limit 20`,
    [workspaceId, publicId],
    workspaceId,
  );
  const plan = result[0]?.['QUERY PLAN'][0]?.Plan;
  if (plan === undefined) throw new Error('Recent history plan is missing');
  const nodes: Plan[] = [];
  const visit = (node: Plan) => {
    nodes.push(node);
    node.Plans?.forEach(visit);
  };
  visit(plan);
  expect(plan['Actual Rows']).toBe(1);
  expect(
    nodes.reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0),
  ).toBeLessThanOrEqual(1);
  // Bound the work too: filtering an entire history into a temporary result is insufficient.
  expect(nodes.every((node) => node['Actual Rows'] <= 20)).toBe(true);
  console.info(JSON.stringify(result[0]?.['QUERY PLAN']));
});

import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';

export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const graph = EMPTY_WORKFLOW_GRAPH;

export const row = {
  workspace_id: workspaceId,
  workflow_id: workflowId,
  revision: 7,
  graph_json: graph,
  updated_by: actorId,
  updated_at: new Date('2026-09-28T00:00:00Z'),
};

export const valid = {
  ok: true as const,
  issues: [] as const,
  expandedInvocations: 0,
  worstCaseLoopIterations: 0,
};

export const budget = { rows: [{ millis: '35000' }] };

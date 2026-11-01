import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import {
  EMPTY_DEFINITION_CATALOG,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const graph = EMPTY_WORKFLOW_GRAPH;

export const catalog = EMPTY_DEFINITION_CATALOG;

export const row = {
  workspace_id: workspaceId,
  workflow_id: workflowId,
  revision: 7,
  graph_json: graph,
  updated_by: actorId,
  updated_at: new Date('2026-09-28T00:00:00Z'),
};

const tag = workflowDraftRepresentationTag({
  workflowId,
  revision: 7,
  graph,
  compatibilityFingerprint: workflowCompatibilityReport(graph, catalog)
    .fingerprint,
});

export const command = {
  workspaceId,
  workflowId,
  actorId,
  representationTag: tag,
  idempotencyKey: 'original-key',
  requestHash: 'a'.repeat(64),
};

export const valid = {
  ok: true as const,
  issues: [] as const,
  expandedInvocations: 0,
  worstCaseLoopIterations: 0,
};

export const invalid = {
  ok: false as const,
  issues: [
    {
      code: 'invalid_expression' as const,
      path: '$.nodes.action.inputMappings.value',
      message: 'The expression cannot be parsed.',
    },
  ],
  expandedInvocations: 0,
  worstCaseLoopIterations: 0,
};

export const budget = { rows: [{ setting: '35000', unit: 'ms' }] };

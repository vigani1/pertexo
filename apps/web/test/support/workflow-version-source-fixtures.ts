import type {
  WorkflowSummary,
  WorkflowVersionResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowCallPin } from './workflow-call-fixtures';

/** Synthetic immutable source responses; no accepted native-execution facts. */
export const callableVersionSource = {
  id: workflowCallPin.versionId,
  workflowId: workflowCallPin.workflowId,
  versionNumber: 2,
  schemaVersion: 2,
  checksum: workflowCallPin.checksum,
  publishedAt: '2026-10-03T10:00:00.000Z',
  graph: {
    schemaVersion: 2,
    nodes: [],
    edges: [],
    settings: {},
    callable: {
      schemaVersion: 1,
      input: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      result: {
        type: 'object',
        properties: { answer: { type: 'integer' } },
        required: ['answer'],
      },
      resultSelector: { kind: 'literal', value: { answer: 1 } },
    },
  },
} satisfies WorkflowVersionResponse;

export function versionSourceWorkflow(workspaceId: string): WorkflowSummary {
  return {
    id: workflowCallPin.workflowId,
    workspaceId,
    name: 'Reusable child source',
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'inactive',
    publishedVersionId: callableVersionSource.id,
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
  };
}

import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  workflowCompatibilityReport,
  type WorkflowDefinitionCatalog,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

import type { WorkflowAuthoringDatabase } from '../../../src/authoring/workflows/contract.js';

export const emptyGraph = {
  edges: [],
  nodes: [],
  settings: {},
};

export const draftNode = (
  id: string,
  config: Record<string, unknown> = {},
) => ({
  id,
  definition: { key: 'test.placeholder', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config,
  inputMappings: {},
  connectionRefs: {},
});

export const testDefinitionCatalog = Object.freeze({
  definitions: Object.freeze([
    Object.freeze({ key: 'test.placeholder', version: 1 }),
  ]),
});

export const baselineEmptyDefinitionCatalog = Object.freeze({
  definitions: Object.freeze([]),
});

export async function currentRepresentationTag(
  database: WorkflowAuthoringDatabase,
  scopedWorkspaceId: string,
  {
    scopedWorkflowId,
    scopedActorId,
    definitionCatalog,
  }: Readonly<{
    scopedWorkflowId: string;
    scopedActorId: string;
    definitionCatalog?: WorkflowDefinitionCatalog | undefined;
  }>,
): Promise<string> {
  const draft = await database.getDraft(
    scopedWorkspaceId,
    scopedWorkflowId,
    scopedActorId,
  );
  if (draft === null) throw new Error('Expected workflow draft');
  return workflowDraftRepresentationTag({
    workflowId: scopedWorkflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint:
      definitionCatalog === undefined
        ? draft.compatibility.fingerprint
        : workflowCompatibilityReport(draft.graphJson, definitionCatalog)
            .fingerprint,
  });
}

export async function saveCurrentDraft(
  database: WorkflowAuthoringDatabase,
  input: Omit<
    Parameters<WorkflowAuthoringDatabase['saveDraft']>[0],
    'representationTag' | 'graphJson'
  > & { graphJson: unknown },
) {
  return database.saveDraft({
    ...input,
    graphJson: parseWorkflowGraphDraft(input.graphJson),
    representationTag: await currentRepresentationTag(
      database,
      input.workspaceId,
      { scopedWorkflowId: input.workflowId, scopedActorId: input.actorId },
    ),
  });
}

export function draftWireRow(
  row: Readonly<{
    workflow_id: string;
    workspace_id: string;
    revision: number;
    graph_json: unknown;
    updated_by: string;
    updated_at: Date;
  }>,
) {
  return [
    row.workflow_id,
    row.workspace_id,
    row.revision,
    row.graph_json,
    row.updated_by,
    row.updated_at.toISOString(),
  ];
}

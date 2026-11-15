import { decodeStoredValue } from '../../shared/stored-values.js';

import type { Role } from '@pertexo/policy';

import {
  parseWorkflowGraphDraft,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import { readFolderScope } from '../../shared/folder-access-facts.repository.js';

import { workflowAccessible } from '../../shared/resources/workflow-access.repository.js';

import type { AuthoringCatalogs } from '../workflows/catalogs.js';

import type { ExportWorkflowInput } from '../workflows/workflow-commands.types.js';

import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/workflow-authoring.errors.js';

import { projectDraft } from '../workflows/representation/workflow-representations.repository.js';
import { draftRepresentationTag } from '../workflows/representation/tag.js';

import {
  shareLockWorkflow,
  shareLockDraft,
  readVersionGraph,
} from './source-authority.repository.js';

/** Lock workflow before its selected source; select catalog only after source. */
export async function lockPortableSource(
  client: PoolClient,
  input: ExportWorkflowInput,
  role: Role,
) {
  if (
    !(await workflowAccessible(
      client,
      await readFolderScope(client, input, role),
      { workspaceId: input.workspaceId, workflowId: input.workflowId },
    ))
  )
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const workflow = await shareLockWorkflow(client, input);
  if (!workflow)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  if (input.source.kind === 'draft') {
    const row = await shareLockDraft(client, input);
    if (row === undefined || row.graphJson === null)
      throw new WorkflowNotFoundError('Workflow source is not visible');
    return { kind: 'draft' as const, row };
  }
  // Immutable versions need only the workflow share lock to prevent purging.
  const row = await readVersionGraph(client, input, input.source.versionId);
  if (row === undefined || row.graphJson === null)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  return { kind: 'version' as const, row };
}

export function reviewedSourceGraph(
  input: ExportWorkflowInput,
  source: Awaited<ReturnType<typeof lockPortableSource>>,
  selection: AuthoringCatalogs,
): WorkflowGraph {
  if (source.kind === 'version')
    return decodeStoredValue(() =>
      parseWorkflowGraphDraft(source.row.graphJson),
    );
  const draft = projectDraft(source.row, selection.definitionCatalog);
  const tag = draftRepresentationTag(input.workflowId, draft);
  if (tag !== input.representationTag)
    throw new WorkflowRevisionConflictError(draft.revision, tag);
  return draft.graphJson;
}

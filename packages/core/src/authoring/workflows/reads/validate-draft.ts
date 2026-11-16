import type { WorkflowActor } from '../../../shared/access/workflow-actor.types.js';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import { projectDraft } from '../representation/workflow-representations.repository.js';
import {
  parseWorkflowGraphDraft,
  sameWorkflowNotes,
} from '@pertexo/workflow-model';
import { compilePublicationGraph } from '../../publication/compile-publication.js';
import type { PoolClient } from 'pg';
import type { FolderScope } from '../../../shared/access/folder-access.types.js';
import { workflowAccessible } from '../../../shared/resources/workflow-access.repository.js';
import type { AuthoringCatalogs } from '../catalogs.js';
import { readDraftRow, readPublishedVersionRow } from './drafts.repository.js';

export async function validateDraft(
  client: PoolClient,
  scope: FolderScope,
  { signal, ...workflow }: WorkflowActor,
  catalogs: AuthoringCatalogs,
) {
  const { workspaceId, workflowId } = workflow;
  if (!(await workflowAccessible(client, scope, workflow))) return null;
  const row = await readDraftRow(client, workspaceId, workflowId);
  if (row === undefined) return null;
  const draft = projectDraft(row, catalogs.definitionCatalog);
  const inspected = await compilePublicationGraph(
    client,
    { ...workflow, signal },
    draft.graphJson,
    catalogs,
  );
  const { validation } = inspected;
  const live = await readPublishedVersionRow(client, workspaceId, workflowId);
  const currentPublication =
    live === undefined
      ? null
      : Object.freeze({
          versionId: live.versionId,
          versionNumber: live.versionNumber,
          matchesDraft:
            validation.ok &&
            draft.compatibility.compatible &&
            inspected.kind === 'ready' &&
            inspected.publication.checksum === live.checksum &&
            sameWorkflowNotes(
              draft.graphJson,
              decodeStoredValue(() => parseWorkflowGraphDraft(live.graphJson)),
            ),
        });
  return Object.freeze({ draft, validation, currentPublication });
}

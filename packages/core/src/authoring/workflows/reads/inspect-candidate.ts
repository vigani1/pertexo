import type { PoolClient } from 'pg';
import {
  InvalidWorkflowGraphError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowActor } from '../../../shared/access/workflow-actor.types.js';
import { compilePublicationGraph } from '../../publication/compile-publication.js';
import type { AuthoringCatalogs } from '../catalogs.js';
import { admitDraftCandidate } from '../admit-draft-candidate.js';
import { projectDraft } from '../representation/workflow-representations.repository.js';
import { draftRepresentationTag } from '../representation/tag.js';
import {
  WorkflowDefinitionPlacementError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflow-authoring.errors.js';
import { readDraftRow } from './drafts.repository.js';

export async function inspectCandidate(
  client: PoolClient,
  input: WorkflowActor & { graph: WorkflowGraph; expectedRevision: number },
  catalogs: AuthoringCatalogs,
) {
  const row = await readDraftRow(client, input.workspaceId, input.workflowId);
  if (row === undefined) throw new WorkflowNotFoundError();
  const base = projectDraft(row, catalogs.definitionCatalog);
  const representationTag = draftRepresentationTag(input.workflowId, base);
  if (base.revision !== input.expectedRevision)
    throw new WorkflowRevisionConflictError(base.revision, representationTag);
  try {
    const refusal = await admitDraftCandidate(client, input, {
      previous: base.graphJson,
      graph: input.graph,
      catalog: catalogs.placementDefinitionCatalog,
    });
    if (refusal !== undefined)
      return {
        kind: 'rejected' as const,
        issues: [
          {
            code: 'invalid_graph' as const,
            path: refusal.path,
            message:
              refusal.kind === 'malformed'
                ? 'The attachment reference is malformed.'
                : 'The attachment is unavailable.',
          },
        ],
      };
  } catch (error) {
    if (
      error instanceof WorkflowDefinitionPlacementError ||
      error instanceof InvalidWorkflowGraphError
    )
      return { kind: 'rejected' as const, issues: error.issues };
    throw error;
  }
  const draft = projectDraft(
    { ...row, graphJson: input.graph },
    catalogs.definitionCatalog,
  );
  const publication = await compilePublicationGraph(
    client,
    input,
    input.graph,
    catalogs,
  );
  return {
    kind: 'inspected' as const,
    base,
    draft,
    validation: publication.validation,
    graphIssues:
      publication.kind === 'graph_refused' ? publication.validation.issues : [],
    representationTag,
  };
}

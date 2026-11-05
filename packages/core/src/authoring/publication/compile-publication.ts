import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/server';
import { generatePersistedId } from '@pertexo/database/platform';
import { dataTableReferenceIssues } from '../../data-tables/columns/references.repository.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.repository.js';
import { lockWorkspaceVariableNames } from '../../variables/head.repository.js';
import { lockArtifactReferences } from '../../artifacts/references/locks.repository.js';
import { admitWorkflowAuthoring } from '../workflows/admission.repository.js';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';
import { validateApprovalAudience } from './pending-tasks.repository.js';
import { stepSettingsIssues } from './step-settings.js';
import { validatePublicationCalls } from './calls.repository.js';
import { connectionReferenceIssues } from './connections.repository.js';
import type {
  CompiledPublication,
  PublicationCandidateInput,
} from './workflow-publication.types.js';
import { executableSchema } from './input.js';

/** Inspect the saved graph against current resources before producing an immutable publication. */
export async function compilePublicationGraph(
  client: PoolClient,
  input: PublicationCandidateInput,
  graphJson: WorkflowGraph,
  variant: AuthoringCatalogs,
): Promise<CompiledPublication> {
  const validation = await admitWorkflowAuthoring(
    client,
    variant.validateAuthoringGraph,
    graphJson,
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      workspaceVariableNames: await lockWorkspaceVariableNames(
        client,
        input.workspaceId,
      ),
    },
  );
  if (!validation.ok) throw new InvalidWorkflowGraphError(validation.issues);
  const graph = parseWorkflowGraphForPublish(
    graphJson,
    variant.definitionCatalog,
  );
  const settingsIssues = stepSettingsIssues(graph, variant.portableCatalog);
  if (settingsIssues.length > 0)
    throw new InvalidWorkflowGraphError(settingsIssues);
  const tableIssues = await dataTableReferenceIssues(
    client,
    input.workspaceId,
    graph,
  );
  if (tableIssues.length > 0) throw new InvalidWorkflowGraphError(tableIssues);
  const connectionIssues = await connectionReferenceIssues(
    client,
    input,
    graph,
  );
  if (connectionIssues.length > 0)
    throw new InvalidWorkflowGraphError(connectionIssues);
  await validateApprovalAudience(client, input.workspaceId, graph);
  await requireWorkflowCallTargets(client, input, graph);
  await lockArtifactReferences(client, input.workspaceId, graph, input.actorId);
  // Injected compilers return unknown executable JSON, so this is its boundary.
  const executable = executableSchema.parse(variant.executableCompiler(graph));
  const versionId = generatePersistedId();
  const { calls } = await validatePublicationCalls(
    client,
    {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      workflowVersionId: versionId,
      executableChecksum: executable.checksum,
    },
    graph,
    validation.expandedInvocations,
  );
  return Object.freeze({
    versionId,
    calls,
    checksum: executable.checksum,
    definitionCatalog: variant.definitionCatalog,
    executable,
    graph,
  });
}

import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.js';
import { recordPromotedPublication } from '../promotion/provenance.js';
import { PublicationReviewError } from '../reviews/contract.js';
import { dataTableReferenceIssues } from '../../data-tables/columns/references.queries.js';
import { lockWorkspaceVariableNames } from '../../variables/settings.queries.js';

import { validateApprovalAudience } from './pending-tasks.js';
import { lockArtifactReferences } from '../../artifacts/references/repository.js';
import {
  claimCommand,
  credentialCommandScope,
  completeCommand,
  type CommandIdentity,
} from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  sameWorkflowNotes,
  InvalidWorkflowGraphError,
} from '@pertexo/workflow-model';
import {
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { admitWorkflowAuthoring } from '../workflows/admission.js';
import type { PoolClient } from 'pg';

import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/errors.js';
import type {
  PublishWorkflowInput,
  PublishWorkflowResult,
} from '../workflows/contracts.js';
import type { WorkflowVersionRecord } from '../workflows/representation/records.js';
import {
  mapDraft,
  mapVersion,
  workflowVersionRowSelection,
} from '../workflows/representation/rows.js';

import { validatePublicationCalls } from './calls.js';
import { connectionReferenceIssues } from './connections.js';

import {
  uuidSchema,
  digestSchema,
  workflowDraftTagSchema,
  executableSchema,
  type WorkflowPublicationDependencies,
  type PublicationCandidateInput,
  type PublicationClaim,
  type CompiledPublication,
  storedPublicationSchema,
} from './contract.js';
import {
  persistPublicationProjections,
  finalizePublication,
} from './projections.js';
export { reconcileWorkflowTriggersPayload } from './trigger-reconciliation.js';
export { type WorkflowPublicationDependencies } from './contract.js';
async function claimPublication(
  client: PoolClient,
  input: PublishWorkflowInput,
): Promise<PublicationClaim> {
  const workflowId = uuidSchema.parse(input.workflowId);
  const command: CommandIdentity = {
    workspaceId: input.workspaceId,
    operation: 'workflow.publish',
    scope: credentialCommandScope(
      `${input.actorId}:${workflowId}`,
      input.commandCredentialId,
    ),
    idempotencyKey: input.idempotencyKey,
  };
  const stored = await claimCommand(client, {
    ...command,
    request: digestSchema.parse(input.requestHash),
    resourceId: workflowId,
  });
  if (stored === null)
    return Object.freeze({ command, replay: null, workflowId });
  const { versionId, reused } = storedPublicationSchema.parse(stored);
  const version = await client.query<Record<string, unknown>>(
    `select ${workflowVersionRowSelection} from app.workflow_versions
     where workspace_id=$1 and workflow_id=$2 and id=$3`,
    [input.workspaceId, workflowId, versionId],
  );
  const row = version.rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow version is not visible');
  return Object.freeze({
    command,
    replay: Object.freeze({ version: mapVersion(row), reused, replayed: true }),
    workflowId,
  });
}

async function lockAndCompilePublication(
  client: PoolClient,
  input: PublicationCandidateInput,
  workflowId: string,
  dependencies: WorkflowPublicationDependencies,
): Promise<CompiledPublication> {
  const variant = dependencies.catalogs;
  const workflow = await client.query(
    `select id from app.workflows where workspace_id=$1 and id=$2
       and lifecycle_status='active' for update`,
    [input.workspaceId, workflowId],
  );
  if (workflow.rows[0] === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const draftResult = await client.query<Record<string, unknown>>(
    `select * from app.workflow_drafts
     where workspace_id=$1 and workflow_id=$2 for update`,
    [input.workspaceId, workflowId],
  );
  const draftRow = draftResult.rows[0];
  if (draftRow === undefined)
    throw new Error('Workflow is missing its required draft');
  const draft = mapDraft(draftRow, variant.definitionCatalog);
  const currentEtag = workflowDraftRepresentationTag({
    workflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: workflowCompatibilityReport(
      draft.graphJson,
      variant.definitionCatalog,
    ).fingerprint,
  });
  if (currentEtag !== workflowDraftTagSchema.parse(input.representationTag))
    throw new WorkflowRevisionConflictError(draft.revision, currentEtag);
  const validation = await admitWorkflowAuthoring(
    client,
    variant.validateAuthoringGraph,
    draft.graphJson,
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
    draft.graphJson,
    variant.definitionCatalog,
  );
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
  const executable = executableSchema.parse(variant.executableCompiler(graph));
  const versionId = generatePersistedId();
  const { calls } = await validatePublicationCalls(
    client,
    {
      workspaceId: input.workspaceId,
      workflowId,
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

async function persistVersion(
  client: PoolClient,
  input: PublicationCandidateInput,
  workflowId: string,
  publication: CompiledPublication,
): Promise<Readonly<{ reused: boolean; version: WorkflowVersionRecord }>> {
  const retained = await client.query<Record<string, unknown>>(
    `select ${workflowVersionRowSelection} from app.workflow_versions
     where workspace_id=$1 and workflow_id=$2 and checksum=$3
     order by version_number`,
    [input.workspaceId, workflowId, publication.checksum],
  );
  let versionRow: Record<string, unknown> | undefined;
  for (const row of retained.rows) {
    const version = mapVersion(row);
    if (sameWorkflowNotes(version.graphJson, publication.graph))
      versionRow = row;
  }
  const reused = versionRow !== undefined;
  if (!reused) {
    const inserted = await client.query<Record<string, unknown>>(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,published_by)
       select $1,$2,$3,coalesce(max(version_number),0)+1,$4::json,$5,
         $6::json,$7 from app.workflow_versions
       where workspace_id=$2 and workflow_id=$3
       returning ${workflowVersionRowSelection}`,
      [
        publication.versionId,
        input.workspaceId,
        workflowId,
        JSON.stringify(publication.graph),
        publication.checksum,
        JSON.stringify(publication.executable.executableJson),
        input.actorId,
      ],
    );
    versionRow = inserted.rows[0];
  }
  if (versionRow === undefined)
    throw new Error('Workflow publication returned no version');
  const version = mapVersion(versionRow);
  return Object.freeze({ reused, version });
}

/** One publication transaction core; only authoring command owners may call it. */
export async function publishWorkflowCandidate(
  dependencies: WorkflowPublicationDependencies,
  client: PoolClient,
  input: PublicationCandidateInput,
): Promise<PublishWorkflowResult> {
  const workflowId = input.workflowId;
  const publication = await lockAndCompilePublication(
    client,
    input,
    workflowId,
    dependencies,
  );
  const { reused, version } = await persistVersion(
    client,
    input,
    workflowId,
    publication,
  );
  await persistPublicationProjections(client, input, {
    workflowId,
    publication,
    version,
  });
  await recordPromotedPublication(client, version);
  await finalizePublication(client, input, {
    workflowId,
    version,
    reused,
  });
  return Object.freeze({ replayed: false, reused, version });
}

export async function publishWorkflowDirectly(
  dependencies: WorkflowPublicationDependencies,
  client: PoolClient,
  input: PublicationCandidateInput,
): Promise<PublishWorkflowResult> {
  const policy = await client.query<{
    require_publish_approval: boolean;
  }>('select require_publish_approval from app.workspaces where id=$1', [
    input.workspaceId,
  ]);
  if (policy.rows[0]?.require_publish_approval ?? false)
    throw new PublicationReviewError(
      'required',
      'This workspace requires publication review. Request approval for the saved draft.',
    );
  return publishWorkflowCandidate(dependencies, client, input);
}

export function createWorkflowPublisher(
  dependencies: WorkflowPublicationDependencies,
): (input: PublishWorkflowInput) => Promise<PublishWorkflowResult> {
  return (input) =>
    dependencies.transact(
      input.workspaceId,
      input.actorId,
      async (client) => {
        await dependencies.requireAuthor(client, input.workspaceId, {
          actorId: input.actorId,
          workflowId: input.workflowId,
        });
        const claim = await claimPublication(client, input);
        if (claim.replay !== null) return claim.replay;
        const result = await publishWorkflowDirectly(
          dependencies,
          client,
          input,
        );
        await completeCommand(client, claim.command, {
          versionId: result.version.id,
          reused: result.reused,
        });
        return result;
      },
      input.signal,
    );
}

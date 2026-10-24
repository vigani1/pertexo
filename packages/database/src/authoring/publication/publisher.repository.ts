import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
} from '../../schema/authoring/workflows.js';
import { workspaces } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.queries.js';
import { recordPromotedPublication } from '../promotion/provenance.repository.js';
import { PublicationReviewError } from '../reviews/contract.js';
import { dataTableReferenceIssues } from '../../data-tables/columns/references.queries.js';
import { lockWorkspaceVariableNames } from '../../variables/settings.queries.js';

import { validateApprovalAudience } from './pending-tasks.queries.js';
import { lockArtifactReferences } from '../../artifacts/references/repository.js';
import {
  claimCommand,
  credentialCommandScope,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import type { CommandIdentity } from '../../platform/idempotency/contract.js';
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
import { admitWorkflowAuthoring } from '../workflows/admission.queries.js';
import type { PoolClient } from 'pg';

import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/errors.js';
import type {
  PublishWorkflowInput,
  PublishWorkflowResult,
} from '../workflows/contract.js';
import type { WorkflowVersionRecord } from '../workflows/representation/contract.js';
import {
  projectDraft,
  projectVersion,
  draftProjection,
  versionProjection,
} from '../workflows/representation/records.queries.js';

import { validatePublicationCalls } from './calls.repository.js';
import { connectionReferenceIssues } from './connections.queries.js';

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
} from './projections.repository.js';
export { reconcileWorkflowTriggersPayload } from './trigger-reconciliation.repository.js';
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
  const [row] = await drizzle(client)
    .select(versionProjection)
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.id, versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow version is not visible');
  return Object.freeze({
    command,
    replay: Object.freeze({
      version: projectVersion(row),
      reused,
      replayed: true,
    }),
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
  const db = drizzle(client);
  const [workflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (workflow === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const [draftRow] = await db
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (draftRow === undefined)
    throw new Error('Workflow is missing its required draft');
  const draft = projectDraft(draftRow, variant.definitionCatalog);
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
  const db = drizzle(client);
  const scope = and(
    eq(workflowVersions.workspaceId, input.workspaceId),
    eq(workflowVersions.workflowId, workflowId),
  );
  const retained = await db
    .select(versionProjection)
    .from(workflowVersions)
    .where(and(scope, eq(workflowVersions.checksum, publication.checksum)))
    .orderBy(asc(workflowVersions.versionNumber))
    .catch(rethrowQueryFailure);
  let versionRow: (typeof retained)[number] | undefined;
  for (const row of retained) {
    const version = projectVersion(row);
    if (sameWorkflowNotes(version.graphJson, publication.graph))
      versionRow = row;
  }
  const reused = versionRow !== undefined;
  if (!reused) {
    const inserted = await db
      .insert(workflowVersions)
      .select(
        db
          .select({
            id: sql<string>`${publication.versionId}::uuid`.as('id'),
            workspaceId: sql<string>`${input.workspaceId}::uuid`.as(
              'workspace_id',
            ),
            workflowId: sql<string>`${workflowId}::uuid`.as('workflow_id'),
            versionNumber:
              sql<number>`coalesce(max(${workflowVersions.versionNumber}),0)+1`.as(
                'version_number',
              ),
            graphJson:
              sql<unknown>`${JSON.stringify(publication.graph)}::json`.as(
                'graph_json',
              ),
            checksum: sql<string>`${publication.checksum}::varchar`.as(
              'checksum',
            ),
            executableJson:
              sql<unknown>`${JSON.stringify(publication.executable.executableJson)}::json`.as(
                'executable_json',
              ),
            publishedBy: sql<string>`${input.actorId}::uuid`.as('published_by'),
            publishedAt: sql<Date>`clock_timestamp()`.as('published_at'),
          })
          .from(workflowVersions)
          .where(scope),
      )
      .returning(versionProjection)
      .catch(rethrowQueryFailure);
    versionRow = inserted[0];
  }
  if (versionRow === undefined)
    throw new Error('Workflow publication returned no version');
  const version = projectVersion(versionRow);
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
  const [policy] = await drizzle(client)
    .select({ requirePublishApproval: workspaces.requirePublishApproval })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .catch(rethrowQueryFailure);
  if (policy?.requirePublishApproval ?? false)
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

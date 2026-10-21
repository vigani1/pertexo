import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.js';
import { recordPromotedPublication } from '../promotion/provenance.js';
import { PublicationReviewError } from '../reviews/contract.js';
import { dataTableReferenceIssues } from '../../data-tables/columns/references.js';
import { lockWorkspaceVariableNames } from '../../variables/read.js';
import { revokeRemovedFormAccess } from '../../triggers/forms/publication.js';
import { validateApprovalAudience } from './pending-tasks.js';
import { lockArtifactReferences } from '../../artifacts/references.js';
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
  type WorkflowGraph,
  type CallableVersionSummary,
} from '@pertexo/workflow-model';
import {
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  type WorkflowDefinitionCatalog,
  workflowDraftRepresentationTag,
  workflowIntegrationUsage,
} from '@pertexo/workflow-model/server';
import { admitWorkflowAuthoring } from '../workflows/admission.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';

import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';
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
import {
  reconcileWorkflowTriggersPayload,
  persistPublishedWorkflowTriggers,
} from './trigger-reconciliation.js';
import { validatePublicationCalls, persistPublicationCalls } from './calls.js';
import { connectionReferenceIssues } from './connections.js';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';

export { reconcileWorkflowTriggersPayload } from './trigger-reconciliation.js';

const uuidSchema = z.uuid();
const digestSchema = sha256HexSchema;
const workflowDraftTagSchema = z
  .string()
  .regex(/^"draft\.[A-Za-z0-9_-]{43}"$/u);
const providerKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const operationKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const executableSchema = z
  .object({
    checksum: z.string().regex(/^wf:sha256:[0-9a-f]{64}$/u),
    executableJson: z.record(z.string(), z.unknown()),
  })
  .strict();

export type WorkflowPublicationDependencies = Readonly<{
  requireAuthor(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
    workflowId?: string,
    capability?: 'workflow:read' | 'workflow:update',
  ): Promise<void>;
  catalogs: AuthoringCatalogs;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;

type PublicationCandidateInput = Omit<
  PublishWorkflowInput,
  'idempotencyKey' | 'requestHash' | 'commandCredentialId'
>;

type PublicationClaim = Readonly<{
  command: CommandIdentity;
  replay: PublishWorkflowResult | null;
  workflowId: string;
}>;

type CompiledPublication = Readonly<{
  versionId: string;
  calls: CallableVersionSummary['calls'];
  checksum: string;
  definitionCatalog: WorkflowDefinitionCatalog;
  executable: z.output<typeof executableSchema>;
  graph: WorkflowGraph;
}>;

/** A retry gets back the version its first attempt published. */
const storedPublicationSchema = z
  .object({ versionId: uuidSchema, reused: z.boolean() })
  .strict();

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
    input.workspaceId,
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
     where workspace_id=$1 and workflow_id=$2 order by version_number`,
    [input.workspaceId, workflowId],
  );
  let versionRow: Record<string, unknown> | undefined;
  for (const row of retained.rows) {
    const version = mapVersion(row);
    if (
      version.checksum === publication.checksum &&
      sameWorkflowNotes(version.graphJson, publication.graph)
    )
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

async function persistPublicationProjections(
  client: PoolClient,
  input: PublicationCandidateInput,
  workflowId: string,
  publication: CompiledPublication,
  version: WorkflowVersionRecord,
): Promise<void> {
  await revokeRemovedFormAccess(
    client,
    input.workspaceId,
    workflowId,
    publication.graph,
  );
  const usage = workflowIntegrationUsage(
    version.graphJson,
    publication.definitionCatalog,
  ).map((item) => ({
    connection_id: uuidSchema.parse(item.connectionId),
    operation_key: operationKeySchema.parse(item.operationKey),
    provider_key: providerKeySchema.parse(item.providerKey),
  }));
  await client.query(
    `delete from app.workflow_integration_usage
     where workspace_id=$1 and workflow_version_id=$2`,
    [input.workspaceId, version.id],
  );
  if (usage.length > 0)
    await client.query(
      `insert into app.workflow_integration_usage
         (workspace_id,workflow_version_id,provider_key,operation_key,connection_id)
       select $1,$2,item.provider_key,item.operation_key,item.connection_id
       from jsonb_to_recordset($3::jsonb) as item(
         provider_key varchar(64),operation_key varchar(128),connection_id uuid)`,
      [input.workspaceId, version.id, JSON.stringify(usage)],
    );
  await persistPublicationCalls(
    client,
    input.workspaceId,
    version.id,
    publication.calls,
  );
  await persistPublishedWorkflowTriggers(client, {
    workspaceId: input.workspaceId,
    workflowId,
    version,
  });
}

async function finalizePublication(
  client: PoolClient,
  input: PublicationCandidateInput,
  workflowId: string,
  version: WorkflowVersionRecord,
  reused: boolean,
): Promise<void> {
  await client.query(
    `update app.workflows set published_version_id=$1,
       activation_status='activating',updated_at=transaction_timestamp()
     where workspace_id=$2 and id=$3`,
    [version.id, input.workspaceId, workflowId],
  );
  const eventId = generatePersistedId();
  const payload = reconcileWorkflowTriggersPayload({
    workspaceId: input.workspaceId,
    outboxEventId: eventId,
    workflowId: workflowId,
    publishedVersionId: version.id,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  });
  await client.query(
    `insert into app.outbox_events
       (id,workspace_id,job_name,aggregate_type,aggregate_id,
        payload,payload_checksum)
     values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
    [
      eventId,
      input.workspaceId,
      workflowId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,
        trace_id,metadata)
     values($1,$2,$3,'workflow.published','workflow',$4,$5,$6,$7::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      workflowId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify({
        checksum: version.checksum,
        reused,
        versionId: version.id,
        versionNumber: version.versionNumber,
      }),
    ],
  );
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
  await persistPublicationProjections(
    client,
    input,
    workflowId,
    publication,
    version,
  );
  await recordPromotedPublication(client, version);
  await finalizePublication(client, input, workflowId, version, reused);
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
  if (policy.rows[0]?.require_publish_approval === true)
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
        await dependencies.requireAuthor(
          client,
          input.workspaceId,
          input.actorId,
          input.workflowId,
        );
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

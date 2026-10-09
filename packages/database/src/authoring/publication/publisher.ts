import {
  claimCommand,
  completeCommand,
  type CommandIdentity,
} from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import {
  InvalidWorkflowGraphError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  type WorkflowDefinitionCatalog,
  workflowDraftRepresentationTag,
  workflowExecutableChecksum,
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
import type {
  WorkflowAuthoringTestHooks,
  WorkflowExecutableCompiler,
  WorkflowAuthoringGraphValidator,
} from '../workflows/types.js';
import type { WorkflowVersionRecord } from '../workflows/records.js';
import {
  mapDraft,
  mapVersion,
  workflowVersionRowSelection,
} from '../workflows/rows.js';
import {
  reconcileWorkflowTriggersPayload,
  persistPublishedWorkflowTriggers,
} from './trigger-reconciliation.js';

export { reconcileWorkflowTriggersPayload } from './trigger-reconciliation.js';

const uuidSchema = z.uuid();
const digestSchema = sha256HexSchema;
const checksumSchema = z.string().regex(/^wf:v[12]:sha256:[0-9a-f]{64}$/u);
const workflowDraftTagSchema = z
  .string()
  .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);
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
    checksum: z.string().regex(/^wf:v2:sha256:[0-9a-f]{64}$/u),
    executableSchemaVersion: z.literal(2),
    executableJson: z.record(z.string(), z.unknown()),
  })
  .strict();

type PublicationVariant = Readonly<{
  definitionCatalog: WorkflowDefinitionCatalog;
  executableCompiler: WorkflowExecutableCompiler | undefined;
  validateAuthoringGraph: WorkflowAuthoringGraphValidator | undefined;
}>;

export type WorkflowPublicationDependencies = Readonly<{
  requireAuthor(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<void>;
  selectVariant(client: Pick<PoolClient, 'query'>): Promise<PublicationVariant>;
  testHooks: WorkflowAuthoringTestHooks | undefined;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;

type PublicationClaim = Readonly<{
  command: CommandIdentity;
  replay: PublishWorkflowResult | null;
  workflowId: string;
}>;

type CompiledPublication = Readonly<{
  checksum: string;
  definitionCatalog: WorkflowDefinitionCatalog;
  executable: z.output<typeof executableSchema> | undefined;
  graph: WorkflowGraph;
  schemaVersion: number;
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
    scope: `${input.actorId}:${workflowId}`,
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
  input: PublishWorkflowInput,
  workflowId: string,
  dependencies: WorkflowPublicationDependencies,
): Promise<CompiledPublication> {
  const variant = await dependencies.selectVariant(client);
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
  await dependencies.testHooks?.afterPublishDraftLock?.();
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
    input.signal,
  );
  if (!validation.ok) throw new InvalidWorkflowGraphError(validation.issues);
  const graph = parseWorkflowGraphForPublish(
    draft.graphJson,
    variant.definitionCatalog,
  );
  const compiled = variant.executableCompiler?.(graph);
  const executable =
    compiled === undefined ? undefined : executableSchema.parse(compiled);
  return Object.freeze({
    checksum: checksumSchema.parse(
      executable?.checksum ??
        workflowExecutableChecksum(graph, variant.definitionCatalog),
    ),
    definitionCatalog: variant.definitionCatalog,
    executable,
    graph,
    schemaVersion: graph.schemaVersion,
  });
}

async function persistVersion(
  client: PoolClient,
  input: PublishWorkflowInput,
  workflowId: string,
  publication: CompiledPublication,
  dependencies: WorkflowPublicationDependencies,
): Promise<Readonly<{ reused: boolean; version: WorkflowVersionRecord }>> {
  const retained = await client.query<Record<string, unknown>>(
    `select ${workflowVersionRowSelection} from app.workflow_versions
     where workspace_id=$1 and workflow_id=$2 order by version_number`,
    [input.workspaceId, workflowId],
  );
  let versionRow: Record<string, unknown> | undefined;
  for (const row of retained.rows) {
    const version = mapVersion(row);
    if (version.checksum === publication.checksum) versionRow = row;
  }
  const reused = versionRow !== undefined;
  if (!reused) {
    const inserted = await client.query<Record<string, unknown>>(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,schema_version,graph_json,
         checksum,executable_schema_version,executable_json,published_by)
       select $1,$2,$3,coalesce(max(version_number),0)+1,$4,$5::jsonb,$6,
         $7,$8::jsonb,$9 from app.workflow_versions
       where workspace_id=$2 and workflow_id=$3
       returning ${workflowVersionRowSelection}`,
      [
        generatePersistedId(),
        input.workspaceId,
        workflowId,
        publication.schemaVersion,
        JSON.stringify(publication.graph),
        publication.checksum,
        publication.executable?.executableSchemaVersion ?? null,
        publication.executable === undefined
          ? null
          : JSON.stringify(publication.executable.executableJson),
        input.actorId,
      ],
    );
    versionRow = inserted.rows[0];
  }
  if (versionRow === undefined)
    throw new Error('Workflow publication returned no version');
  const version = mapVersion(versionRow);
  await dependencies.testHooks?.afterPublishStep?.('version');
  return Object.freeze({ reused, version });
}

async function persistPublicationProjections(
  client: PoolClient,
  input: PublishWorkflowInput,
  workflowId: string,
  publication: CompiledPublication,
  version: WorkflowVersionRecord,
  hooks: WorkflowAuthoringTestHooks | undefined,
): Promise<void> {
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
  await hooks?.afterPublishStep?.('integration_usage');
  await persistPublishedWorkflowTriggers(client, {
    workspaceId: input.workspaceId,
    workflowId,
    version,
  });
  await hooks?.afterPublishStep?.('trigger_projection');
}

async function finalizePublication(
  client: PoolClient,
  input: PublishWorkflowInput,
  claim: PublicationClaim,
  version: WorkflowVersionRecord,
  reused: boolean,
  hooks: WorkflowAuthoringTestHooks | undefined,
): Promise<void> {
  await client.query(
    `update app.workflows set published_version_id=$1,
       activation_status='activating',updated_at=transaction_timestamp()
     where workspace_id=$2 and id=$3`,
    [version.id, input.workspaceId, claim.workflowId],
  );
  await hooks?.afterPublishStep?.('pointer');
  const eventId = generatePersistedId();
  const payload = reconcileWorkflowTriggersPayload({
    workspaceId: input.workspaceId,
    outboxEventId: eventId,
    workflowId: claim.workflowId,
    publishedVersionId: version.id,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  });
  await client.query(
    `insert into app.outbox_events
       (id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
        payload,payload_checksum)
     values($1,$2,'reconcile-workflow-triggers',1,'workflow',$3,$4::jsonb,$5)`,
    [
      eventId,
      input.workspaceId,
      claim.workflowId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  await hooks?.afterPublishStep?.('outbox');
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,
        trace_id,metadata)
     values($1,$2,$3,'workflow.published','workflow',$4,$5,$6,$7::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      claim.workflowId,
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
  await hooks?.afterPublishStep?.('audit');
  await completeCommand(client, claim.command, {
    versionId: version.id,
    reused,
  });
  await hooks?.afterPublishStep?.('idempotency');
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
        );
        const claim = await claimPublication(client, input);
        if (claim.replay !== null) return claim.replay;
        const publication = await lockAndCompilePublication(
          client,
          input,
          claim.workflowId,
          dependencies,
        );
        const { reused, version } = await persistVersion(
          client,
          input,
          claim.workflowId,
          publication,
          dependencies,
        );
        await persistPublicationProjections(
          client,
          input,
          claim.workflowId,
          publication,
          version,
          dependencies.testHooks,
        );
        await finalizePublication(
          client,
          input,
          claim,
          version,
          reused,
          dependencies.testHooks,
        );
        return Object.freeze({ replayed: false, reused, version });
      },
      input.signal,
    );
}

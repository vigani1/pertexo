import { generatePersistedId } from '../platform/persisted-id.js';

import {
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  workflowExecutableChecksum,
  workflowIntegrationUsage,
  type WorkflowDefinitionCatalogV1,
  type WorkflowGraph,
} from '@pertexo/workflow-model/graph';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

import type { CompatibilityReleaseExpectation } from '../compatibility/compatibility-release.js';
import { canonicalOutboxPayloadChecksum } from '../execution/outbox.js';
import {
  WorkflowNotFoundError,
  WorkflowIdempotencyConflictError,
  WorkflowRevisionConflictError,
} from './workflow-authoring-errors.js';
import type {
  PublishWorkflowInput,
  PublishWorkflowResult,
  WorkflowAuthoringTestHooks,
  WorkflowDraftRecord,
  WorkflowExecutableCompiler,
  WorkflowVersionRecord,
} from './workflow-authoring.js';
import { workflowVersionRowSelection } from './workflow-authoring-rows.js';
import { workflowTriggerProjection } from '../triggers/workflow-trigger-projection.js';

const uuidSchema = z.uuid();
const digestSchema = sha256HexSchema;
const checksumSchema = z.string().regex(/^wf:v[12]:sha256:[0-9a-f]{64}$/u);
const workflowDraftTagSchema = z
  .string()
  .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));
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
    compatibilityReleaseEpoch: z.number().int().positive(),
    compatibilityReleaseFingerprint: z
      .string()
      .regex(/^node-compat:v1:sha256:[0-9a-f]{64}$/u),
  })
  .strict();

type PublicationVariant = Readonly<{
  compatibilityRelease: CompatibilityReleaseExpectation | undefined;
  definitionCatalog: WorkflowDefinitionCatalogV1;
  executableCompiler: WorkflowExecutableCompiler | undefined;
}>;

export type WorkflowPublicationDependencies = Readonly<{
  durableResult(value: unknown): Omit<PublishWorkflowResult, 'replayed'>;
  keyDigest(key: string): string;
  mapDraft(
    row: Record<string, unknown>,
    definitionCatalog: WorkflowDefinitionCatalogV1,
  ): WorkflowDraftRecord;
  mapVersion(row: Record<string, unknown>): WorkflowVersionRecord;
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
  ): Promise<T>;
}>;

type PublicationClaim = Readonly<{
  digest: string;
  replay: PublishWorkflowResult | null;
  scope: string;
  workflowId: string;
}>;

type CompiledPublication = Readonly<{
  checksum: string;
  definitionCatalog: WorkflowDefinitionCatalogV1;
  executable: z.output<typeof executableSchema> | undefined;
  graph: WorkflowGraph;
  schemaVersion: number;
}>;

async function claimPublication(
  client: PoolClient,
  input: PublishWorkflowInput,
  dependencies: WorkflowPublicationDependencies,
): Promise<PublicationClaim> {
  const workflowId = uuidSchema.parse(input.workflowId);
  const requestHash = digestSchema.parse(input.requestHash);
  const scope = `${input.actorId}:${workflowId}`;
  const digest = dependencies.keyDigest(input.idempotencyKey);
  await client.query(
    `insert into app.idempotency_records
       (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
     values($1,$2,'workflow.publish',$3,$4,$5,'in_progress',$6,'{}'::jsonb)
     on conflict (workspace_id,operation,scope,key_hash) do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      scope,
      digest,
      requestHash,
      workflowId,
    ],
  );
  const result = await client.query<{
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select request_hash,status,result_ref from app.idempotency_records
     where workspace_id=$1 and operation='workflow.publish'
       and scope=$2 and key_hash=$3 for update`,
    [input.workspaceId, scope, digest],
  );
  const claimed = result.rows[0];
  if (claimed === undefined)
    throw new Error('Publish idempotency claim is unavailable');
  if (claimed.request_hash !== requestHash)
    throw new WorkflowIdempotencyConflictError(
      'Idempotency key request mismatch',
    );
  return Object.freeze({
    digest,
    replay:
      claimed.status === 'completed'
        ? Object.freeze({
            ...dependencies.durableResult(claimed.result_ref),
            replayed: true,
          })
        : null,
    scope,
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
  const lockedRelease = variant.compatibilityRelease;
  if (lockedRelease !== undefined)
    await dependencies.testHooks?.afterCompatibilityReleaseLock?.();
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
  const draft = dependencies.mapDraft(draftRow, variant.definitionCatalog);
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
  const graph = parseWorkflowGraphForPublish(
    draft.graphJson,
    variant.definitionCatalog,
  );
  const compiled = variant.executableCompiler?.(graph);
  const executable =
    compiled === undefined ? undefined : executableSchema.parse(compiled);
  if (executable !== undefined) {
    if (lockedRelease === undefined)
      throw new Error(
        'Compiled workflow compatibility release has no locked authority',
      );
    if (
      executable.compatibilityReleaseEpoch !== lockedRelease.epoch ||
      executable.compatibilityReleaseFingerprint !==
        lockedRelease.fingerprint ||
      executable.executableJson.compatibilityReleaseEpoch !==
        lockedRelease.epoch ||
      executable.executableJson.compatibilityReleaseFingerprint !==
        lockedRelease.fingerprint
    )
      throw new Error(
        'Compiled workflow compatibility release does not match the locked authority',
      );
  }
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
    const version = dependencies.mapVersion(row);
    if (version.checksum === publication.checksum) versionRow = row;
  }
  const reused = versionRow !== undefined;
  if (!reused) {
    const inserted = await client.query<Record<string, unknown>>(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,schema_version,graph_json,
         checksum,executable_schema_version,executable_json,
         compatibility_release_epoch,published_by)
       select $1,$2,$3,coalesce(max(version_number),0)+1,$4,$5::jsonb,$6,
         $7,$8::jsonb,$9,$10 from app.workflow_versions
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
        publication.executable?.compatibilityReleaseEpoch ?? null,
        input.actorId,
      ],
    );
    versionRow = inserted.rows[0];
  }
  if (versionRow === undefined)
    throw new Error('Workflow publication returned no version');
  const version = dependencies.mapVersion(versionRow);
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
  const triggers = workflowTriggerProjection(version.graphJson);
  await client.query(
    `delete from app.workflow_triggers
     where workspace_id=$1 and workflow_version_id=$2
       and not (node_id=any($3::varchar[]))`,
    [input.workspaceId, version.id, triggers.map(({ nodeId }) => nodeId)],
  );
  if (triggers.length > 0) {
    const projection = triggers.map((trigger) => ({
      id: generatePersistedId(),
      node_id: trigger.nodeId,
      kind: trigger.kind,
      desired_config: trigger.config,
      config_fingerprint: trigger.configFingerprint,
    }));
    await client.query(
      `insert into app.workflow_triggers (
         id,workspace_id,workflow_id,workflow_version_id,node_id,kind,
         desired_config,config_fingerprint,status)
       select item.id,$1,$2,$3,item.node_id,item.kind,item.desired_config,
         item.config_fingerprint,'desired'
       from jsonb_to_recordset($4::jsonb) as item(
         id uuid,node_id varchar(128),kind varchar(16),desired_config jsonb,
         config_fingerprint varchar(82))
       on conflict (workflow_version_id,node_id) do update set
         desired_config=excluded.desired_config,
         config_fingerprint=excluded.config_fingerprint
       where app.workflow_triggers.workspace_id=excluded.workspace_id
         and app.workflow_triggers.workflow_id=excluded.workflow_id
         and app.workflow_triggers.kind=excluded.kind`,
      [input.workspaceId, workflowId, version.id, JSON.stringify(projection)],
    );
  }
  await hooks?.afterPublishStep?.('trigger_projection');
}

export function reconcileWorkflowTriggersPayload(
  input: Readonly<{
    outboxEventId: string;
    publishedVersionId: string;
    traceparent?: string;
    workflowId: string;
    workspaceId: string;
  }>,
): Record<string, unknown> {
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: uuidSchema.parse(input.workspaceId),
    outboxEventId: uuidSchema.parse(input.outboxEventId),
    workflowId: uuidSchema.parse(input.workflowId),
    publishedVersionId: uuidSchema.parse(input.publishedVersionId),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: traceparentSchema.parse(input.traceparent) }),
  });
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
       activation_status='inactive',updated_at=transaction_timestamp()
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
  await client.query(
    `update app.idempotency_records set status='completed',result_ref=$1::jsonb,
       updated_at=transaction_timestamp()
     where workspace_id=$2 and operation='workflow.publish'
       and scope=$3 and key_hash=$4`,
    [
      JSON.stringify({
        version: { ...version, publishedAt: version.publishedAt.toISOString() },
        reused,
      }),
      input.workspaceId,
      claim.scope,
      claim.digest,
    ],
  );
  await hooks?.afterPublishStep?.('idempotency');
}

export function createWorkflowPublisher(
  dependencies: WorkflowPublicationDependencies,
): (input: PublishWorkflowInput) => Promise<PublishWorkflowResult> {
  return (input) =>
    dependencies.transact(input.workspaceId, input.actorId, async (client) => {
      await dependencies.requireAuthor(
        client,
        input.workspaceId,
        input.actorId,
      );
      const claim = await claimPublication(client, input, dependencies);
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
    });
}

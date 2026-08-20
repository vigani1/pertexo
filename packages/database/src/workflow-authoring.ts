import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  EMPTY_DEFINITION_CATALOG_V1,
  parseWorkflowGraphDraft,
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  workflowExecutableChecksum,
  workflowRetainedExecutableChecksum,
  type WorkflowDefinitionCatalogV1,
  type WorkflowGraph,
} from '@pertexo/workflow-model/graph';

import type { DatabaseConfig } from './config.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';

const uuidSchema = z.uuid();
const checksumSchema = z.string().regex(/^wf:v1:sha256:[0-9a-f]{64}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nameSchema = z.string().trim().min(1).max(128);
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));
const workflowDraftTagSchema = z
  .string()
  .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);

export class WorkflowNotFoundError extends Error {
  public override readonly name = 'WorkflowNotFoundError';
}

export class WorkflowRevisionConflictError extends Error {
  public override readonly name = 'WorkflowRevisionConflictError';
  public constructor(
    public readonly currentRevision: number,
    public readonly currentEtag: string,
  ) {
    super('Workflow draft revision does not match');
  }
}

export class WorkflowPublishIdempotencyConflictError extends Error {
  public override readonly name = 'WorkflowPublishIdempotencyConflictError';
}

export class WorkflowCreateIdempotencyConflictError extends Error {
  public override readonly name = 'WorkflowCreateIdempotencyConflictError';
}

export type WorkflowRecord = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  lifecycleStatus: 'active' | 'archived';
  activationStatus: 'inactive';
  publishedVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkflowDraftRecord = Readonly<{
  workflowId: string;
  workspaceId: string;
  revision: number;
  schemaVersion: number;
  graphJson: WorkflowGraph;
  compatibility: ReturnType<typeof workflowCompatibilityReport>;
  updatedBy: string;
  updatedAt: Date;
}>;

export type WorkflowVersionRecord = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  versionNumber: number;
  schemaVersion: number;
  graphJson: WorkflowGraph;
  checksum: string;
  publishedBy: string;
  publishedAt: Date;
}>;

export type CreateWorkflowInput = Readonly<{
  id?: string;
  workspaceId: string;
  actorId: string;
  name: string;
  emptyGraph: unknown;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;

export type CreateWorkflowResult = Readonly<{
  workflowId: string;
  workflow: WorkflowRecord;
  draft: WorkflowDraftRecord;
}>;

export type SaveWorkflowDraftInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  expectedRevision: number;
  graphJson: unknown;
  requestId?: string;
  traceId?: string;
}>;

export type PublishWorkflowInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  representationTag: string;
  /** Canonical application request digest, including the original If-Match. */
  requestHash: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;

export type ListWorkflowsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  limit?: number;
  after?: Readonly<{ createdAt: Date; id: string }>;
}>;

export type WorkflowPage = Readonly<{
  items: readonly WorkflowRecord[];
  nextCursor?: Readonly<{ createdAt: Date; id: string }>;
}>;

export type ListWorkflowVersionsInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  limit?: number;
  beforeVersionNumber?: number;
}>;

export type WorkflowVersionPage = Readonly<{
  items: readonly WorkflowVersionRecord[];
  nextCursor?: Readonly<{ beforeVersionNumber: number }>;
}>;

export type PublishWorkflowResult = Readonly<{
  version: WorkflowVersionRecord;
  reused: boolean;
  replayed: boolean;
}>;

export function reconcileWorkflowTriggersPayload(
  input: Readonly<{
    workspaceId: string;
    outboxEventId: string;
    workflowId: string;
    publishedVersionId: string;
    traceparent?: string;
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

export type WorkflowAuthoringDatabase = Readonly<{
  createWorkflow(input: CreateWorkflowInput): Promise<CreateWorkflowResult>;
  listWorkflows(input: ListWorkflowsInput): Promise<WorkflowPage>;
  getDraft(
    workspaceId: string,
    workflowId: string,
    actorId: string,
  ): Promise<WorkflowDraftRecord | null>;
  getVersion(
    workspaceId: string,
    workflowId: string,
    versionId: string,
    actorId: string,
  ): Promise<WorkflowVersionRecord | null>;
  listVersions(input: ListWorkflowVersionsInput): Promise<WorkflowVersionPage>;
  saveDraft(input: SaveWorkflowDraftInput): Promise<WorkflowDraftRecord>;
  publishWorkflow(input: PublishWorkflowInput): Promise<PublishWorkflowResult>;
  close(): Promise<void>;
}>;

export type WorkflowAuthoringTestHooks = Readonly<{
  /** Integration-test synchronization seam; runtime composition must omit it. */
  afterSaveCas?: () => Promise<void>;
  /** Integration-test synchronization/fault seam after both publish locks. */
  afterPublishDraftLock?: () => Promise<void>;
  afterPublishStep?: (
    step: 'version' | 'pointer' | 'outbox' | 'audit' | 'idempotency',
  ) => Promise<void>;
}>;

export type WorkflowAuthoringDatabaseOptions = Readonly<{
  definitionCatalog?: WorkflowDefinitionCatalogV1;
  testHooks?: WorkflowAuthoringTestHooks;
}>;

function mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
  const publishedVersionId = row.published_version_id;
  if (publishedVersionId !== null && typeof publishedVersionId !== 'string') {
    throw new Error('Database returned an invalid published version ID');
  }
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    lifecycleStatus: row.lifecycle_status as 'active' | 'archived',
    activationStatus: 'inactive',
    publishedVersionId,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as Date),
    updatedAt: new Date(row.updated_at as Date),
  });
}

function mapDraft(
  row: Record<string, unknown>,
  definitionCatalog: WorkflowDefinitionCatalogV1,
): WorkflowDraftRecord {
  const graph = parseWorkflowGraphDraft(row.graph_json);
  return Object.freeze({
    workflowId: String(row.workflow_id),
    workspaceId: String(row.workspace_id),
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    graphJson: graph,
    compatibility: workflowCompatibilityReport(graph, definitionCatalog),
    updatedBy: String(row.updated_by),
    updatedAt: new Date(row.updated_at as Date),
  });
}

function mapVersion(row: Record<string, unknown>): WorkflowVersionRecord {
  const graph = parseWorkflowGraphDraft(row.graph_json);
  const schemaVersion = Number(row.schema_version);
  if (schemaVersion !== graph.schemaVersion) {
    throw new Error('Stored workflow version schema does not match its graph');
  }
  const checksum = checksumSchema.parse(row.checksum);
  if (checksum !== workflowRetainedExecutableChecksum(graph)) {
    throw new Error(
      'Stored workflow version checksum does not match its graph',
    );
  }
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workflowId: String(row.workflow_id),
    versionNumber: Number(row.version_number),
    schemaVersion,
    graphJson: graph,
    checksum,
    publishedBy: String(row.published_by),
    publishedAt: new Date(row.published_at as Date),
  });
}

async function withAuthorTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  actorIdInput: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const workspaceId = uuidSchema.parse(workspaceIdInput);
  const actorId = uuidSchema.parse(actorIdInput);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
      [workspaceId, actorId],
    );
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function requireWorkspaceAuthor(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.workspaces workspace on workspace.id = membership.workspace_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active' and membership.role in ('owner', 'admin', 'builder')
       and workspace.status = 'active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

async function requireWorkspaceReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.workspaces workspace on workspace.id = membership.workspace_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active' and workspace.status = 'active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

function keyDigest(key: string): string {
  return createHash('sha256')
    .update(idempotencyKeySchema.parse(key))
    .digest('hex');
}

function durablePublishResult(
  value: unknown,
): Omit<PublishWorkflowResult, 'replayed'> {
  const parsed = z
    .object({
      version: z
        .object({
          id: z.uuid(),
          workspaceId: z.uuid(),
          workflowId: z.uuid(),
          versionNumber: z.number().int().positive(),
          schemaVersion: z.number().int().positive(),
          graphJson: z.unknown(),
          checksum: checksumSchema,
          publishedBy: z.uuid(),
          publishedAt: z.iso.datetime(),
        })
        .strict(),
      reused: z.boolean(),
    })
    .strict()
    .parse(value);
  const version = mapVersion({
    id: parsed.version.id,
    workspace_id: parsed.version.workspaceId,
    workflow_id: parsed.version.workflowId,
    version_number: parsed.version.versionNumber,
    schema_version: parsed.version.schemaVersion,
    graph_json: parsed.version.graphJson,
    checksum: parsed.version.checksum,
    published_by: parsed.version.publishedBy,
    published_at: parsed.version.publishedAt,
  });
  return Object.freeze({
    version,
    reused: parsed.reused,
  });
}

export function createWorkflowAuthoringDatabase(
  config: DatabaseConfig,
  options: WorkflowAuthoringDatabaseOptions = {},
): WorkflowAuthoringDatabase {
  // Runtime import is kept here so the public package remains straightforward to test.
  const pool = new Pool(config);
  const definitionCatalog =
    options.definitionCatalog ?? EMPTY_DEFINITION_CATALOG_V1;
  return Object.freeze({
    createWorkflow: async (input) =>
      withAuthorTransaction(
        pool,
        input.workspaceId,
        input.actorId,
        async (client) => {
          const workflowId = uuidSchema.parse(input.id ?? randomUUID());
          const graph = parseWorkflowGraphDraft(input.emptyGraph);
          const schemaVersion = graph.schemaVersion;
          await requireWorkspaceAuthor(
            client,
            input.workspaceId,
            input.actorId,
          );
          const requestHash = canonicalOutboxPayloadChecksum({
            actorId: input.actorId,
            graph,
            name: nameSchema.parse(input.name),
            requestedWorkflowId: input.id ?? null,
            schemaVersion,
            workspaceId: input.workspaceId,
          });
          let createdId: string;
          try {
            const creation = await client.query<{ workflow_id: string }>(
              `select app.create_workflow_with_draft(
                 $1, $2, $3::varchar, $4, $5, $6::jsonb, $7::char(64),
                 $8::char(64), $9::varchar, $10::varchar
               ) as workflow_id`,
              [
                workflowId,
                input.workspaceId,
                nameSchema.parse(input.name),
                input.actorId,
                schemaVersion,
                JSON.stringify(graph),
                keyDigest(input.idempotencyKey),
                requestHash,
                input.requestId ?? null,
                input.traceId ?? null,
              ],
            );
            createdId = uuidSchema.parse(creation.rows[0]?.workflow_id);
          } catch (error: unknown) {
            if (
              error instanceof Error &&
              (error as Error & { code?: string }).code === '23505'
            ) {
              throw new WorkflowCreateIdempotencyConflictError(
                'Workflow create idempotency key request mismatch',
              );
            }
            throw error;
          }
          const created = await client.query<Record<string, unknown>>(
            `select workflow.*, row_to_json(draft.*) as draft
             from app.workflows workflow
             join app.workflow_drafts draft
               on draft.workspace_id = workflow.workspace_id
              and draft.workflow_id = workflow.id
             where workflow.workspace_id = $1 and workflow.id = $2`,
            [input.workspaceId, createdId],
          );
          const row = created.rows[0];
          if (
            row === undefined ||
            typeof row.draft !== 'object' ||
            row.draft === null
          ) {
            throw new Error('Workflow creation returned no atomic draft');
          }
          return Object.freeze({
            workflowId: createdId,
            workflow: mapWorkflow(row),
            draft: mapDraft(
              row.draft as Record<string, unknown>,
              definitionCatalog,
            ),
          });
        },
      ),
    listWorkflows: async (input) =>
      withAuthorTransaction(
        pool,
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireWorkspaceReader(
            client,
            input.workspaceId,
            input.actorId,
          );
          const limit = z
            .number()
            .int()
            .positive()
            .max(100)
            .parse(input.limit ?? 50);
          const afterCreatedAt = input.after?.createdAt ?? null;
          if (
            afterCreatedAt !== null &&
            (!(afterCreatedAt instanceof Date) ||
              !Number.isFinite(afterCreatedAt.getTime()))
          ) {
            throw new Error('Invalid workflow list cursor time');
          }
          const afterId =
            input.after === undefined ? null : uuidSchema.parse(input.after.id);
          const result = await client.query<Record<string, unknown>>(
            `select * from app.workflows where workspace_id = $1
             and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
           order by created_at, id limit $4`,
            [input.workspaceId, afterCreatedAt, afterId, limit + 1],
          );
          const hasMore = result.rows.length > limit;
          const items = Object.freeze(
            result.rows.slice(0, limit).map((row) => mapWorkflow(row)),
          );
          const last = items.at(-1);
          return Object.freeze({
            items,
            ...(hasMore && last !== undefined
              ? {
                  nextCursor: Object.freeze({
                    createdAt: last.createdAt,
                    id: last.id,
                  }),
                }
              : {}),
          });
        },
      ),
    getDraft: async (workspaceId, workflowId, actorId) =>
      withAuthorTransaction(pool, workspaceId, actorId, async (client) => {
        await requireWorkspaceReader(client, workspaceId, actorId);
        const result = await client.query<Record<string, unknown>>(
          'select * from app.workflow_drafts where workspace_id = $1 and workflow_id = $2',
          [workspaceId, uuidSchema.parse(workflowId)],
        );
        return result.rows[0] === undefined
          ? null
          : mapDraft(result.rows[0], definitionCatalog);
      }),
    getVersion: async (workspaceId, workflowId, versionId, actorId) =>
      withAuthorTransaction(pool, workspaceId, actorId, async (client) => {
        await requireWorkspaceReader(client, workspaceId, actorId);
        const result = await client.query<Record<string, unknown>>(
          'select * from app.workflow_versions where workspace_id = $1 and workflow_id = $2 and id = $3',
          [
            workspaceId,
            uuidSchema.parse(workflowId),
            uuidSchema.parse(versionId),
          ],
        );
        return result.rows[0] === undefined ? null : mapVersion(result.rows[0]);
      }),
    listVersions: async (input) =>
      withAuthorTransaction(
        pool,
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireWorkspaceReader(
            client,
            input.workspaceId,
            input.actorId,
          );
          const workflowId = uuidSchema.parse(input.workflowId);
          const visible = await client.query(
            'select 1 from app.workflows where workspace_id = $1 and id = $2',
            [input.workspaceId, workflowId],
          );
          if (visible.rowCount !== 1) {
            throw new WorkflowNotFoundError('Workflow is not visible');
          }
          const limit = z
            .number()
            .int()
            .positive()
            .max(100)
            .parse(input.limit ?? 50);
          const beforeVersionNumber =
            input.beforeVersionNumber === undefined
              ? null
              : z.number().int().positive().parse(input.beforeVersionNumber);
          const result = await client.query<Record<string, unknown>>(
            `select * from app.workflow_versions
             where workspace_id = $1 and workflow_id = $2
               and ($3::integer is null or version_number < $3)
             order by version_number desc limit $4`,
            [input.workspaceId, workflowId, beforeVersionNumber, limit + 1],
          );
          const hasMore = result.rows.length > limit;
          const items = Object.freeze(
            result.rows.slice(0, limit).map((row) => mapVersion(row)),
          );
          const last = items.at(-1);
          return Object.freeze({
            items,
            ...(hasMore && last !== undefined
              ? {
                  nextCursor: Object.freeze({
                    beforeVersionNumber: last.versionNumber,
                  }),
                }
              : {}),
          });
        },
      ),
    saveDraft: async (input) =>
      withAuthorTransaction(
        pool,
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireWorkspaceAuthor(
            client,
            input.workspaceId,
            input.actorId,
          );
          const graph = parseWorkflowGraphDraft(input.graphJson);
          const expected = z
            .number()
            .int()
            .positive()
            .parse(input.expectedRevision);
          const workflowId = uuidSchema.parse(input.workflowId);
          const result = await client.query<Record<string, unknown>>(
            `update app.workflow_drafts set graph_json = $1::jsonb, schema_version = $2,
           revision = revision + 1, updated_by = $3, updated_at = transaction_timestamp()
         where workspace_id = $4 and workflow_id = $5 and revision = $6
           and exists (
             select 1 from app.workflows workflow
             where workflow.workspace_id = $4 and workflow.id = $5
               and workflow.lifecycle_status = 'active'
           )
         returning *`,
            [
              JSON.stringify(graph),
              graph.schemaVersion,
              input.actorId,
              input.workspaceId,
              workflowId,
              expected,
            ],
          );
          if (result.rows[0] === undefined) {
            const current = await client.query<Record<string, unknown>>(
              `select draft.* from app.workflow_drafts draft
               join app.workflows workflow
                 on workflow.workspace_id = draft.workspace_id
                and workflow.id = draft.workflow_id
               where draft.workspace_id = $1 and draft.workflow_id = $2
                 and workflow.lifecycle_status = 'active'`,
              [input.workspaceId, workflowId],
            );
            const currentRow = current.rows[0];
            if (currentRow === undefined)
              throw new WorkflowNotFoundError('Workflow is not visible');
            const currentDraft = mapDraft(currentRow, definitionCatalog);
            throw new WorkflowRevisionConflictError(
              currentDraft.revision,
              workflowDraftRepresentationTag({
                workflowId,
                revision: currentDraft.revision,
                graph: currentDraft.graphJson,
                compatibilityFingerprint:
                  currentDraft.compatibility.fingerprint,
              }),
            );
          }
          const saved = mapDraft(result.rows[0], definitionCatalog);
          await options.testHooks?.afterSaveCas?.();
          await client.query(
            `insert into app.audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, request_id, trace_id, metadata)
         values ($1, $2, $3, 'workflow.draft_saved', 'workflow', $4, $5, $6, $7::jsonb)`,
            [
              randomUUID(),
              input.workspaceId,
              input.actorId,
              input.workflowId,
              input.requestId ?? null,
              input.traceId ?? null,
              JSON.stringify({
                previousRevision: expected,
                revision: saved.revision,
              }),
            ],
          );
          return saved;
        },
      ),
    publishWorkflow: async (input) =>
      withAuthorTransaction(
        pool,
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireWorkspaceAuthor(
            client,
            input.workspaceId,
            input.actorId,
          );
          const workflowId = uuidSchema.parse(input.workflowId);
          const requestHash = digestSchema.parse(input.requestHash);
          const scope = `${input.actorId}:${workflowId}`;
          const digest = keyDigest(input.idempotencyKey);
          await client.query(
            `insert into app.idempotency_records (id, workspace_id, operation, scope, key_hash, request_hash, status, resource_id, result_ref)
         values ($1, $2, 'workflow.publish', $3, $4, $5, 'in_progress', $6, '{}'::jsonb)
         on conflict (workspace_id, operation, scope, key_hash) do nothing`,
            [
              randomUUID(),
              input.workspaceId,
              scope,
              digest,
              requestHash,
              workflowId,
            ],
          );
          const claim = await client.query<{
            request_hash: string;
            status: string;
            result_ref: unknown;
          }>(
            `select request_hash, status, result_ref from app.idempotency_records
         where workspace_id = $1 and operation = 'workflow.publish' and scope = $2 and key_hash = $3 for update`,
            [input.workspaceId, scope, digest],
          );
          const claimed = claim.rows[0];
          if (claimed === undefined)
            throw new Error('Publish idempotency claim is unavailable');
          if (claimed.request_hash !== requestHash)
            throw new WorkflowPublishIdempotencyConflictError(
              'Idempotency key request mismatch',
            );
          if (claimed.status === 'completed') {
            const replay = durablePublishResult(claimed.result_ref);
            return Object.freeze({ ...replay, replayed: true });
          }
          const workflow = await client.query(
            "select id from app.workflows where workspace_id = $1 and id = $2 and lifecycle_status = 'active' for update",
            [input.workspaceId, workflowId],
          );
          if (workflow.rows[0] === undefined)
            throw new WorkflowNotFoundError('Workflow is not visible');
          const draftResult = await client.query<Record<string, unknown>>(
            'select * from app.workflow_drafts where workspace_id = $1 and workflow_id = $2 for update',
            [input.workspaceId, workflowId],
          );
          const draft =
            draftResult.rows[0] === undefined
              ? null
              : mapDraft(draftResult.rows[0], definitionCatalog);
          if (draft === null)
            throw new Error('Workflow is missing its required draft');
          await options.testHooks?.afterPublishDraftLock?.();
          const currentEtag = workflowDraftRepresentationTag({
            workflowId,
            revision: draft.revision,
            graph: draft.graphJson,
            compatibilityFingerprint: workflowCompatibilityReport(
              draft.graphJson,
              definitionCatalog,
            ).fingerprint,
          });
          if (
            currentEtag !==
            workflowDraftTagSchema.parse(input.representationTag)
          )
            throw new WorkflowRevisionConflictError(
              draft.revision,
              currentEtag,
            );
          const graph = parseWorkflowGraphForPublish(
            draft.graphJson,
            definitionCatalog,
          );
          const schemaVersion = graph.schemaVersion;
          const checksum = checksumSchema.parse(
            workflowExecutableChecksum(graph, definitionCatalog),
          );
          const retainedResult = await client.query<Record<string, unknown>>(
            `select * from app.workflow_versions
             where workspace_id = $1 and workflow_id = $2
             order by version_number`,
            [input.workspaceId, workflowId],
          );
          const retainedVersions = retainedResult.rows.map((row) =>
            mapVersion(row),
          );
          const retainedVersion = retainedVersions.find(
            (version) => version.checksum === checksum,
          );
          let versionRow =
            retainedVersion === undefined
              ? undefined
              : retainedResult.rows.find(
                  (row) => row.id === retainedVersion.id,
                );
          const reused = versionRow !== undefined;
          if (!reused) {
            const versionId = randomUUID();
            const inserted = await client.query<Record<string, unknown>>(
              `insert into app.workflow_versions (id, workspace_id, workflow_id, version_number, schema_version, graph_json, checksum, published_by)
           select $1, $2, $3, coalesce(max(version_number), 0) + 1, $4, $5::jsonb, $6, $7
           from app.workflow_versions where workspace_id = $2 and workflow_id = $3 returning *`,
              [
                versionId,
                input.workspaceId,
                workflowId,
                schemaVersion,
                JSON.stringify(graph),
                checksum,
                input.actorId,
              ],
            );
            versionRow = inserted.rows[0];
          }
          if (versionRow === undefined) {
            throw new Error('Workflow publication returned no version');
          }
          const version = mapVersion(versionRow);
          await options.testHooks?.afterPublishStep?.('version');
          await client.query(
            "update app.workflows set published_version_id = $1, activation_status = 'inactive', updated_at = transaction_timestamp() where workspace_id = $2 and id = $3",
            [version.id, input.workspaceId, workflowId],
          );
          await options.testHooks?.afterPublishStep?.('pointer');
          const eventId = randomUUID();
          const payload = reconcileWorkflowTriggersPayload({
            workspaceId: input.workspaceId,
            outboxEventId: eventId,
            workflowId,
            publishedVersionId: version.id,
            ...(input.traceparent === undefined
              ? {}
              : { traceparent: input.traceparent }),
          });
          await client.query(
            `insert into app.outbox_events (id, workspace_id, job_name, schema_version, aggregate_type, aggregate_id, payload, payload_checksum)
         values ($1, $2, 'reconcile-workflow-triggers', 1, 'workflow', $3, $4::jsonb, $5)`,
            [
              eventId,
              input.workspaceId,
              workflowId,
              JSON.stringify(payload),
              canonicalOutboxPayloadChecksum(payload),
            ],
          );
          await options.testHooks?.afterPublishStep?.('outbox');
          await client.query(
            `insert into app.audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, request_id, trace_id, metadata)
         values ($1, $2, $3, 'workflow.published', 'workflow', $4, $5, $6, $7::jsonb)`,
            [
              randomUUID(),
              input.workspaceId,
              input.actorId,
              workflowId,
              input.requestId ?? null,
              input.traceId ?? null,
              JSON.stringify({
                checksum,
                reused,
                versionId: version.id,
                versionNumber: version.versionNumber,
              }),
            ],
          );
          await options.testHooks?.afterPublishStep?.('audit');
          const durable = {
            version: {
              ...version,
              publishedAt: version.publishedAt.toISOString(),
            },
            reused,
          };
          await client.query(
            `update app.idempotency_records set status = 'completed', result_ref = $1::jsonb, updated_at = transaction_timestamp()
         where workspace_id = $2 and operation = 'workflow.publish' and scope = $3 and key_hash = $4`,
            [JSON.stringify(durable), input.workspaceId, scope, digest],
          );
          await options.testHooks?.afterPublishStep?.('idempotency');
          return Object.freeze({ version, reused, replayed: false });
        },
      ),
    close: async () => pool.end(),
  });
}

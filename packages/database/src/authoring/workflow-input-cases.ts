import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  canonicalJson,
  inspectJsonValue,
} from '@pertexo/workflow-model/canonical-json';
import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';
import { rolesForCapability } from '../tenant-access/workspace-policy.js';
import { serializeStoredExecutionJsonValue } from '../platform/stored-execution-value.js';
import {
  WorkflowNotFoundError,
  WorkflowIdempotencyConflictError,
} from './workflow-authoring-errors.js';

export type WorkflowInputCaseMetadata = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  versionChecksum: string;
  name: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}>;
export type WorkflowInputCaseResult = Readonly<{
  caseId: string;
  revision: number;
  replayed: boolean;
}>;
type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  signal?: AbortSignal;
}>;
type Command = Scope &
  Readonly<{ idempotencyKey: string; requestId?: string; traceId?: string }>;
export interface WorkflowInputCaseDatabase {
  listCases(
    input: Scope & { limit: number; cursor?: { createdAt: Date; id: string } },
  ): Promise<{
    items: readonly WorkflowInputCaseMetadata[];
    nextCursor?: { createdAt: Date; id: string };
  }>;
  getCase(
    input: Scope & { caseId: string },
  ): Promise<{ case: WorkflowInputCaseMetadata & { input: unknown } }>;
  createCase(
    input: Command & {
      workflowVersionId: string;
      name: string;
      input: unknown;
    },
  ): Promise<WorkflowInputCaseResult>;
  updateCase(
    input: Command & {
      caseId: string;
      expectedRevision: number;
      name: string;
      input: unknown;
    },
  ): Promise<WorkflowInputCaseResult>;
  deleteCase(
    input: Command & { caseId: string; expectedRevision: number },
  ): Promise<WorkflowInputCaseResult>;
  close(): Promise<void>;
}
export class WorkflowInputCaseRevisionConflictError extends Error {
  override readonly name = 'WorkflowInputCaseRevisionConflictError';
  constructor(readonly currentRevision: number) {
    super('Run-input case revision changed');
  }
}
export class WorkflowInputCaseLimitError extends Error {
  override readonly name = 'WorkflowInputCaseLimitError';
  constructor(
    readonly kind: 'workflow_count' | 'workspace_count' | 'retained_bytes',
  ) {
    super('Run-input case storage limit reached');
  }
}
export class WorkflowInputCaseUnavailableError extends Error {
  override readonly name = 'WorkflowInputCaseUnavailableError';
  constructor() {
    super('Run-input cases are not enabled');
  }
}
const scopeSchema = z.object({
  workspaceId: z.uuid(),
  actorId: z.uuid(),
  workflowId: z.uuid(),
  signal: z.instanceof(AbortSignal).optional(),
});
const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));
const revisionSchema = z.number().int().positive().max(2_147_483_646);
const receiptSchema = z
  .object({ caseId: z.uuid(), revision: revisionSchema })
  .strict();
const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const metadataColumns =
  'id,workspace_id,workflow_id,workflow_version_id,version_checksum,name,revision,created_at,updated_at';
function metadata(row: Record<string, unknown>): WorkflowInputCaseMetadata {
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workspaceId: z.uuid().parse(row.workspace_id),
    workflowId: z.uuid().parse(row.workflow_id),
    workflowVersionId: z.uuid().parse(row.workflow_version_id),
    versionChecksum: z.string().parse(row.version_checksum),
    name: z.string().parse(row.name),
    revision: revisionSchema.parse(row.revision),
    createdAt: z.coerce.date().parse(row.created_at),
    updatedAt: z.coerce.date().parse(row.updated_at),
  });
}
function payload(value: unknown): { text: string; bytes: number } {
  serializeStoredExecutionJsonValue(value);
  const inspection = inspectJsonValue(value);
  if (
    inspection.bytes > 65_536 ||
    inspection.depth > 64 ||
    inspection.members > 10_000
  )
    throw new TypeError('Run-input case JSON exceeds its bounds');
  const text = canonicalJson(value);
  return { text, bytes: inspection.bytes };
}
async function authority(
  client: PoolClient,
  input: Scope,
  write: boolean,
): Promise<void> {
  const workspace = await client.query(
    "select id from app.workspaces where id=$1 and status='active' for share",
    [input.workspaceId],
  );
  if (workspace.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const actor = await client.query(
    "select id from app.users where id=$1 and status='active' for share",
    [input.actorId],
  );
  if (actor.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const membership = await client.query(
    "select user_id from app.workspace_memberships where workspace_id=$1 and user_id=$2 and status='active' and role=any($3::text[]) for share",
    [
      input.workspaceId,
      input.actorId,
      [...rolesForCapability(write ? 'workflow:update' : 'workflow:read')],
    ],
  );
  if (membership.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}
async function workflow(
  client: PoolClient,
  input: Scope,
  write: boolean,
): Promise<void> {
  const row = await client.query<{ lifecycle_status: string }>(
    'select lifecycle_status from app.workflows where workspace_id=$1 and id=$2 for share',
    [input.workspaceId, input.workflowId],
  );
  if (
    row.rowCount !== 1 ||
    (write && row.rows[0]?.lifecycle_status !== 'active')
  )
    throw new WorkflowNotFoundError('Workflow is not visible');
}

type CaseTransaction = <T>(
  input: Scope,
  write: boolean,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

async function mutate(
  transact: CaseTransaction,
  input: Command,
  kind: 'create' | 'update' | 'delete',
  intent: Record<string, unknown>,
  work: (client: PoolClient) => Promise<{ caseId: string; revision: number }>,
): Promise<WorkflowInputCaseResult> {
  const keyHash = hash(keySchema.parse(input.idempotencyKey));
  const requestHash = hash(
    canonicalJson({
      domain: 'pertexo.workflow-input-case.command',
      version: 1,
      actorId: input.actorId,
      workflowId: input.workflowId,
      workspaceId: input.workspaceId,
      kind,
      ...intent,
    }),
  );
  return transact(input, true, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `workflow-input-case:${input.workspaceId}:${input.actorId}:${input.workflowId}:${kind}:${keyHash}`,
    ]);
    const prior = await client.query<{
      request_hash: string;
      case_id: string;
      revision: number;
    }>(
      'select request_hash,case_id,revision from app.workflow_input_case_receipts where workspace_id=$1 and actor_id=$2 and workflow_id=$3 and operation=$4 and key_hash=$5',
      [input.workspaceId, input.actorId, input.workflowId, kind, keyHash],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash)
        throw new WorkflowIdempotencyConflictError(
          'Idempotency key request mismatch',
        );
      const result = receiptSchema.parse({
        caseId: prior.rows[0].case_id,
        revision: prior.rows[0].revision,
      });
      return Object.freeze({ ...result, replayed: true });
    }
    await workflow(client, input, true);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `workflow-input-case-quota:${input.workspaceId}`,
    ]);
    await client.query(
      "select set_config('app.workflow_input_case_writer',$1,true)",
      [`${input.workspaceId}:${input.workflowId}`],
    );
    const result = await work(client);
    await client.query(
      'insert into app.workflow_input_case_receipts(workspace_id,actor_id,workflow_id,operation,key_hash,request_hash,case_id,revision) values($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        input.workspaceId,
        input.actorId,
        input.workflowId,
        kind,
        keyHash,
        requestHash,
        result.caseId,
        result.revision,
      ],
    );
    await client.query(
      "insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata) values($1,$2,$3,$4,'workflow_input_case',$5,$6,$7,$8::jsonb)",
      [
        generatePersistedId(),
        input.workspaceId,
        input.actorId,
        `workflow.input_case.${kind}`,
        result.caseId,
        input.requestId ?? null,
        input.traceId ?? null,
        JSON.stringify({
          workflowId: input.workflowId,
          revision: result.revision,
        }),
      ],
    );
    return Object.freeze({ ...result, replayed: false });
  });
}
async function quota(
  client: PoolClient,
  input: Scope,
  bytes: number,
  create: boolean,
): Promise<void> {
  const result = await client.query<{
    workflow_count: string;
    workspace_count: string;
    retained_bytes: string;
  }>(
    `select (select count(*) from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 and deleted_at is null) workflow_count,(select count(*) from app.workflow_input_cases where workspace_id=$1 and deleted_at is null) workspace_count,(select coalesce(sum(canonical_bytes),0) from app.workflow_input_case_payloads where workspace_id=$1) retained_bytes`,
    [input.workspaceId, input.workflowId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Case quota authority unavailable');
  if (create && Number(row.workflow_count) >= 20)
    throw new WorkflowInputCaseLimitError('workflow_count');
  if (create && Number(row.workspace_count) >= 200)
    throw new WorkflowInputCaseLimitError('workspace_count');
  if (Number(row.retained_bytes) + bytes > 4_194_304)
    throw new WorkflowInputCaseLimitError('retained_bytes');
}
async function lockedCase(
  client: PoolClient,
  input: Scope & { caseId: string; expectedRevision: number },
): Promise<WorkflowInputCaseMetadata> {
  z.uuid().parse(input.caseId);
  revisionSchema.parse(input.expectedRevision);
  const result = await client.query<Record<string, unknown>>(
    `select ${metadataColumns} from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 and id=$3 and deleted_at is null for update`,
    [input.workspaceId, input.workflowId, input.caseId],
  );
  if (!result.rows[0])
    throw new WorkflowNotFoundError('Run-input case is not visible');
  const item = metadata(result.rows[0]);
  if (item.revision !== input.expectedRevision)
    throw new WorkflowInputCaseRevisionConflictError(item.revision);
  return item;
}

/** Durable bounded authoring commands; no caller manages locks or quota counters. */
export function createWorkflowInputCaseDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowInputCaseDatabase {
  const lease = acquireDatabasePool(config, options.runtime);
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  async function transact<T>(
    input: Scope,
    write: boolean,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    scopeSchema.parse(input);
    if (closed) throw new Error('Run-input case database is closed');
    const operation = withTenantScopedClient(
      lease.pool,
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (client) => {
        await authority(client, input, write);
        try {
          await client.query(
            'select app.assert_workflow_input_cases_enabled()',
          );
        } catch (error: unknown) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '55000'
          )
            throw new WorkflowInputCaseUnavailableError();
          throw error;
        }
        return work(client);
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  }
  return Object.freeze<WorkflowInputCaseDatabase>({
    listCases: (input) =>
      transact(input, false, async (client) => {
        const limit = z.number().int().min(1).max(100).parse(input.limit);
        await workflow(client, input, false);
        const result = await client.query<Record<string, unknown>>(
          `select ${metadataColumns} from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 and deleted_at is null and ($3::timestamptz is null or (created_at,id)>($3,$4::uuid)) order by created_at,id limit $5`,
          [
            input.workspaceId,
            input.workflowId,
            input.cursor?.createdAt ?? null,
            input.cursor?.id ?? null,
            limit + 1,
          ],
        );
        const items = result.rows.slice(0, limit).map(metadata);
        const last = items.at(-1);
        return {
          items,
          ...(result.rows.length > limit && last
            ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
            : {}),
        };
      }),
    getCase: (input) =>
      transact(input, false, async (client) => {
        z.uuid().parse(input.caseId);
        await workflow(client, input, false);
        const result = await client.query<Record<string, unknown>>(
          `select c.*,p.input from app.workflow_input_cases c join app.workflow_input_case_payloads p on p.workspace_id=c.workspace_id and p.case_id=c.id and p.revision=c.revision where c.workspace_id=$1 and c.workflow_id=$2 and c.id=$3 and c.deleted_at is null`,
          [input.workspaceId, input.workflowId, input.caseId],
        );
        if (!result.rows[0])
          throw new WorkflowNotFoundError('Run-input case is not visible');
        return {
          case: {
            ...metadata(result.rows[0]),
            input: JSON.parse(
              z.string().parse(result.rows[0].input),
            ) as unknown,
          },
        };
      }),
    createCase: async (input) => {
      const name = z.string().trim().min(1).max(128).parse(input.name);
      z.uuid().parse(input.workflowVersionId);
      const json = payload(input.input);
      return mutate(
        transact,
        input,
        'create',
        {
          workflowVersionId: input.workflowVersionId,
          name,
          input: JSON.parse(json.text),
        },
        async (client) => {
          const version = await client.query<{ checksum: string }>(
            'select checksum from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
            [input.workspaceId, input.workflowId, input.workflowVersionId],
          );
          if (!version.rows[0])
            throw new WorkflowNotFoundError('Workflow version is not visible');
          await quota(client, input, json.bytes, true);
          const caseId = generatePersistedId();
          await client.query(
            'insert into app.workflow_input_cases(id,workspace_id,workflow_id,workflow_version_id,version_checksum,name) values($1,$2,$3,$4,$5,$6)',
            [
              caseId,
              input.workspaceId,
              input.workflowId,
              input.workflowVersionId,
              version.rows[0].checksum,
              name,
            ],
          );
          await client.query(
            'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes) values($1,$2,1,$3,$4)',
            [input.workspaceId, caseId, json.text, json.bytes],
          );
          return { caseId, revision: 1 };
        },
      );
    },
    updateCase: async (input) => {
      const name = z.string().trim().min(1).max(128).parse(input.name);
      const json = payload(input.input);
      return mutate(
        transact,
        input,
        'update',
        {
          caseId: input.caseId,
          expectedRevision: input.expectedRevision,
          name,
          input: JSON.parse(json.text),
        },
        async (client) => {
          const item = await lockedCase(client, input);
          await quota(client, input, json.bytes, false);
          const revision = item.revision + 1;
          await client.query(
            'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes) values($1,$2,$3,$4,$5)',
            [input.workspaceId, input.caseId, revision, json.text, json.bytes],
          );
          await client.query(
            'update app.workflow_input_cases set name=$1,revision=$2,updated_at=clock_timestamp() where workspace_id=$3 and id=$4',
            [name, revision, input.workspaceId, input.caseId],
          );
          return { caseId: input.caseId, revision };
        },
      );
    },
    deleteCase: (input) =>
      mutate(
        transact,
        input,
        'delete',
        { caseId: input.caseId, expectedRevision: input.expectedRevision },
        async (client) => {
          const item = await lockedCase(client, input);
          const revision = item.revision + 1;
          await client.query(
            'update app.workflow_input_cases set deleted_at=clock_timestamp(),revision=$1,updated_at=clock_timestamp() where workspace_id=$2 and id=$3',
            [revision, input.workspaceId, input.caseId],
          );
          return { caseId: input.caseId, revision };
        },
      ),
    close: () => {
      closed = true;
      closing ??= Promise.allSettled([...pending]).then(() => lease.close());
      return closing;
    },
  });
}

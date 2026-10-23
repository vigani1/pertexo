import { utf8ByteLength } from '@pertexo/workflow-model';
import { lockArtifactReferences } from '../../artifacts/references.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  canonicalJson,
  DEFAULT_TEST_EXPECTATIONS,
  workflowTestExpectationsSchema,
  type WorkflowTestExpectations,
} from '@pertexo/workflow-model';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import {
  type WorkflowInputCaseResult,
  type Scope,
  type Command,
  type WorkflowInputCaseDatabase,
  scopeSchema,
  resultSchema,
  payload,
  type CaseTransaction,
} from './contract.js';
import {
  metadataColumns,
  metadata,
  workflow,
  quota,
  lockedCase,
  lockInputCaseQuota,
} from './records.js';

export {
  type WorkflowInputCaseMetadata,
  type WorkflowInputCaseResult,
  type WorkflowInputCaseDatabase,
  WorkflowInputCaseRevisionConflictError,
  WorkflowInputCaseLimitError,
} from './contract.js';
export { lockInputCaseQuota } from './records.js';
async function mutate(
  transact: CaseTransaction,
  input: Command,
  kind: 'create' | 'update' | 'delete',
  caseId: string,
  intent: Record<string, unknown>,
  work: (client: PoolClient) => Promise<{ caseId: string; revision: number }>,
): Promise<WorkflowInputCaseResult> {
  const command = {
    workspaceId: input.workspaceId,
    operation: `workflow.inputcase.${kind}`,
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  return transact(input, true, async (client) => {
    const stored = await claimCommand(client, {
      ...command,
      request: intent,
      resourceId: caseId,
    });
    if (stored !== null)
      return Object.freeze({ ...resultSchema.parse(stored), replayed: true });
    await workflow(client, input, true);
    await lockInputCaseQuota(client, input.workspaceId);
    const result = await work(client);
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
    await completeCommand(client, command, result);
    return Object.freeze({ ...result, replayed: false });
  });
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
        await lockWorkflowAuthoringAuthority(
          client,
          input.workspaceId,
          input.actorId,
          rolesForCapability(write ? 'workflow:update' : 'workflow:read'),
          {
            workflowId: input.workflowId,
            capability: write ? 'workflow:update' : 'workflow:read',
          },
        );
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
    listCases: (input) => listInputCases(transact, input),
    getCase: (input) => getInputCase(transact, input),
    createCase: (input) => createInputCase(transact, input),
    updateCase: (input) => updateInputCase(transact, input),
    deleteCase: (input) => deleteInputCase(transact, input),
    close: () => {
      closed = true;
      closing ??= Promise.allSettled([...pending]).then(() => lease.close());
      return closing;
    },
  });
}

function listInputCases(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['listCases']>[0],
): ReturnType<WorkflowInputCaseDatabase['listCases']> {
  return transact(input, false, async (client) => {
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
  });
}

function getInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['getCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['getCase']> {
  return transact(input, false, async (client) => {
    z.uuid().parse(input.caseId);
    await workflow(client, input, false);
    const result = await client.query<
      Record<string, unknown> & { expectations: string | null }
    >(
      `select c.*,p.input,p.expectations from app.workflow_input_cases c join app.workflow_input_case_payloads p on p.workspace_id=c.workspace_id and p.case_id=c.id and p.revision=c.revision where c.workspace_id=$1 and c.workflow_id=$2 and c.id=$3 and c.deleted_at is null`,
      [input.workspaceId, input.workflowId, input.caseId],
    );
    if (!result.rows[0])
      throw new WorkflowNotFoundError('Run-input case is not visible');
    return {
      case: {
        ...metadata(result.rows[0]),
        expectations:
          result.rows[0].expectations === null
            ? DEFAULT_TEST_EXPECTATIONS
            : (JSON.parse(
                result.rows[0].expectations,
              ) as WorkflowTestExpectations),
        input: JSON.parse(z.string().parse(result.rows[0].input)) as unknown,
      },
    };
  });
}

async function createInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['createCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['createCase']> {
  const name = z.string().trim().min(1).max(128).parse(input.name);
  z.uuid().parse(input.workflowVersionId);
  const json = payload(input.input);
  const expectations =
    input.expectations === undefined
      ? null
      : canonicalJson(workflowTestExpectationsSchema.parse(input.expectations));
  const caseId = generatePersistedId();
  return mutate(
    transact,
    input,
    'create',
    caseId,
    {
      workflowVersionId: input.workflowVersionId,
      name,
      input: JSON.parse(json.text),
      ...(input.expectations === undefined
        ? {}
        : { expectations: input.expectations }),
    },
    async (client) => {
      const version = await client.query<{ checksum: string }>(
        'select checksum from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
        [input.workspaceId, input.workflowId, input.workflowVersionId],
      );
      if (!version.rows[0])
        throw new WorkflowNotFoundError('Workflow version is not visible');
      await quota(
        client,
        input,
        json.bytes + (expectations === null ? 0 : utf8ByteLength(expectations)),
        true,
      );
      await lockArtifactReferences(
        client,
        input.workspaceId,
        input.input,
        input.actorId,
      );
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
        'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes,expectations) values($1,$2,1,$3,$4,$5)',
        [
          input.workspaceId,
          caseId,
          json.text,
          json.bytes +
            (expectations === null ? 0 : utf8ByteLength(expectations)),
          expectations,
        ],
      );
      return { caseId, revision: 1 };
    },
  );
}

async function updateInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['updateCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['updateCase']> {
  const name = z.string().trim().min(1).max(128).parse(input.name);
  const json = payload(input.input);
  return mutate(
    transact,
    input,
    'update',
    z.uuid().parse(input.caseId),
    {
      caseId: input.caseId,
      expectedRevision: input.expectedRevision,
      name,
      input: JSON.parse(json.text),
      ...(input.expectations === undefined
        ? {}
        : { expectations: input.expectations }),
    },
    async (client) => {
      const item = await lockedCase(client, input);
      const previous = await client.query<{ expectations: string | null }>(
        'select expectations from app.workflow_input_case_payloads where workspace_id=$1 and case_id=$2 and revision=$3',
        [input.workspaceId, input.caseId, item.revision],
      );
      const expectations =
        input.expectations === undefined
          ? (previous.rows[0]?.expectations ?? null)
          : canonicalJson(
              workflowTestExpectationsSchema.parse(input.expectations),
            );
      const bytes =
        json.bytes + (expectations === null ? 0 : utf8ByteLength(expectations));
      await quota(client, input, bytes, false);
      await lockArtifactReferences(
        client,
        input.workspaceId,
        input.input,
        input.actorId,
      );
      const revision = item.revision + 1;
      await client.query(
        'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes,expectations) values($1,$2,$3,$4,$5,$6)',
        [
          input.workspaceId,
          input.caseId,
          revision,
          json.text,
          bytes,
          expectations,
        ],
      );
      await client.query(
        'update app.workflow_input_cases set name=$1,revision=$2,updated_at=clock_timestamp() where workspace_id=$3 and id=$4',
        [name, revision, input.workspaceId, input.caseId],
      );
      return { caseId: input.caseId, revision };
    },
  );
}

async function deleteInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['deleteCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['deleteCase']> {
  return mutate(
    transact,
    input,
    'delete',
    z.uuid().parse(input.caseId),
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
  );
}

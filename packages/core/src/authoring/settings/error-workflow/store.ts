import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { readPolicy } from './policy.queries.js';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowVersions,
  workflowErrorPolicies,
} from '@pertexo/database/schema';
import type { FolderScope } from '../../../shared/contract.js';
import { workflowAccessible } from '../../../tenant-access/resources/workflows.queries.js';
import { workflowScopeSql } from '../../../shared/scope.queries.js';
import type { PoolClient } from 'pg';
import { isWorkflowErrorTarget } from '@pertexo/workflow-model';
import type {
  WorkflowErrorSettings,
  WorkflowErrorSettingsRequest,
  WorkflowErrorTargetsPage,
} from '@pertexo/contracts';
import type { AuthoringAccess, WorkflowActor } from '../../workflows/access.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';

const TARGETS_PAGE = 50;

type Scope = WorkflowActor & Readonly<{ requestId?: string; traceId?: string }>;
export type ListErrorWorkflowTargetsInput = Scope &
  Readonly<{ after?: string }>;
export type UpdateErrorWorkflowSettingsInput = Scope &
  WorkflowErrorSettingsRequest &
  Readonly<{ idempotencyKey: string }>;
export class WorkflowErrorSettingsConflictError extends Error {
  public override readonly name = 'WorkflowErrorSettingsConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Error workflow settings changed. Reload and try again.');
  }
}
export class WorkflowErrorTargetUnavailableError extends Error {
  public override readonly name = 'WorkflowErrorTargetUnavailableError';
  public constructor() {
    super(
      'Choose a different active workflow published with When a workflow fails.',
    );
  }
}
export type WorkflowErrorStore = ReturnType<typeof createWorkflowErrorStore>;

/** Operational Settings share the authoring transaction and current authority fence. */
export function createWorkflowErrorStore(access: AuthoringAccess) {
  return Object.freeze({
    listTargets: (input: ListErrorWorkflowTargetsInput) =>
      access.workflow(
        input,
        { capability: 'workflow:update' },
        (client, scope) => listErrorWorkflowTargets(client, scope, input),
      ),
    readSettings: (input: Scope) =>
      access.workflow(
        input,
        {
          capability: 'workflow:read',
          statuses: BROWSABLE_WORKSPACE_STATUSES,
        },
        (client, scope) => readErrorWorkflowSettings(client, scope, input),
      ),
    updateSettings: (input: UpdateErrorWorkflowSettingsInput) =>
      access.workflow(
        input,
        { capability: 'workflow:update' },
        (client, scope) => updateErrorWorkflowSettings(client, scope, input),
      ),
  });
}

async function listErrorWorkflowTargets(
  client: PoolClient,
  access: FolderScope,
  input: ListErrorWorkflowTargetsInput,
): Promise<WorkflowErrorTargetsPage> {
  const db = drizzle(client);
  const source = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (source.length !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      graph: sql<unknown>`${workflowVersions.executableJson}->'graph'`,
    })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workspaceId, workflows.workspaceId),
        eq(workflowVersions.id, workflows.publishedVersionId),
      ),
    )
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        workflowScopeSql(access, sql`${workflows.id}`, 'workflow:update'),
        ne(workflows.id, input.workflowId),
        eq(workflows.lifecycleStatus, 'active'),
        input.after === undefined ? undefined : gt(workflows.id, input.after),
        sql`${workflowVersions.executableJson}::jsonb @> '{"graph":{"nodes":[{"definition":{"key":"core.workflow_error","version":1}}]}}'::jsonb`,
      ),
    )
    .orderBy(asc(workflows.id))
    .limit(TARGETS_PAGE + 1)
    .catch(rethrowQueryFailure);
  const page = rows.slice(0, TARGETS_PAGE);
  return {
    items: page
      .filter((row) => isWorkflowErrorTarget(row.graph))
      .map((row) => ({ id: row.id, name: row.name })),
    nextCursor: rows.length > TARGETS_PAGE ? (page.at(-1)?.id ?? null) : null,
  };
}

async function readErrorWorkflowSettings(
  client: PoolClient,
  access: FolderScope,
  input: Scope,
): Promise<WorkflowErrorSettings> {
  const source = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  if (source.length !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
  return readPolicy(client, input.workspaceId, input.workflowId, access);
}

async function updateErrorWorkflowSettings(
  client: PoolClient,
  access: FolderScope,
  input: UpdateErrorWorkflowSettingsInput,
): Promise<Readonly<{ settings: WorkflowErrorSettings; replayed: boolean }>> {
  if (
    input.targetWorkflowId !== null &&
    !(await workflowAccessible(client, access, {
      workspaceId: input.workspaceId,
      workflowId: input.targetWorkflowId,
      capability: 'workflow:update',
    }))
  )
    throw new WorkflowNotFoundError('Workflow is not visible');
  // Stable order also covers two editors choosing each other's workflows.
  const ids = [
    ...new Set([
      input.workflowId,
      ...(input.targetWorkflowId === null ? [] : [input.targetWorkflowId]),
    ]),
  ].sort();
  const db = drizzle(client);
  const locked = await db
    .select({
      id: workflows.id,
      lifecycleStatus: workflows.lifecycleStatus,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        inArray(workflows.id, ids),
      ),
    )
    .orderBy(asc(workflows.id))
    .for('update')
    .catch(rethrowQueryFailure);
  if (locked.length !== ids.length)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const identity = {
    workspaceId: input.workspaceId,
    operation: 'workflow.error.policy',
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const request = {
    targetWorkflowId: input.targetWorkflowId,
    expectedRevision: input.expectedRevision,
  };
  const replay = await claimCommand<WorkflowErrorSettings>(client, {
    ...identity,
    request,
    resourceId: input.workflowId,
  });
  if (replay !== null)
    return {
      settings: replay,
      replayed: true,
    };
  const policy = await readPolicy(
    client,
    input.workspaceId,
    input.workflowId,
    access,
  );
  if (policy.revision !== input.expectedRevision)
    throw new WorkflowErrorSettingsConflictError(policy.revision);
  if (input.targetWorkflowId !== null) {
    if (input.targetWorkflowId === input.workflowId)
      throw new WorkflowErrorTargetUnavailableError();
    await requirePublishedErrorTarget(client, {
      workspaceId: input.workspaceId,
      targetWorkflowId: input.targetWorkflowId,
    });
  }
  const settings = {
    targetWorkflowId: input.targetWorkflowId,
    revision: policy.revision + 1,
  };
  await db
    .insert(workflowErrorPolicies)
    .values({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      targetWorkflowId: settings.targetWorkflowId,
      revision: settings.revision,
    })
    .onConflictDoUpdate({
      target: [
        workflowErrorPolicies.workspaceId,
        workflowErrorPolicies.workflowId,
      ],
      set: {
        targetWorkflowId: sql`excluded.target_workflow_id`,
        revision: sql`excluded.revision`,
      },
    })
    .catch(rethrowQueryFailure);
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'workflow.error_policy_updated',
    targetType: 'workflow',
    targetId: input.workflowId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: { targetWorkflowId: settings.targetWorkflowId },
  });
  await completeCommand(client, identity, settings);
  return { settings, replayed: false };
}

async function requirePublishedErrorTarget(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; targetWorkflowId: string }>,
): Promise<void> {
  const [target] = await drizzle(client)
    .select({
      graph: sql<unknown>`${workflowVersions.executableJson}->'graph'`,
    })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workspaceId, workflows.workspaceId),
        eq(workflowVersions.id, workflows.publishedVersionId),
      ),
    )
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.targetWorkflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (!isWorkflowErrorTarget(target?.graph))
    throw new WorkflowErrorTargetUnavailableError();
}

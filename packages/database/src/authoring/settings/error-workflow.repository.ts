import { readPolicy } from './error-policy.queries.js';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowVersions,
} from '../../schema/authoring/workflows.js';
import { workflowErrorPolicies } from '../../schema/authoring/error-workflow.js';
import { auditEvents } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';
import type { PoolClient } from 'pg';
import { isWorkflowErrorTarget } from '@pertexo/workflow-model';
import type {
  WorkflowErrorSettings,
  WorkflowErrorSettingsRequest,
  WorkflowErrorTargetsPage,
} from '@pertexo/contracts';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { rolesForCapability } from '@pertexo/workflow-model';

type Scope = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}>;
type Transact = <T>(
  workspaceId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
export interface WorkflowErrorDatabase {
  listTargets(
    input: Scope & Readonly<{ after?: string }>,
  ): Promise<WorkflowErrorTargetsPage>;
  readSettings(input: Scope): Promise<WorkflowErrorSettings>;
  updateSettings(
    input: Scope &
      WorkflowErrorSettingsRequest &
      Readonly<{ idempotencyKey: string }>,
  ): Promise<Readonly<{ settings: WorkflowErrorSettings; replayed: boolean }>>;
}
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
/** Operational Settings share the authoring transaction and current authority fence. */
export function createWorkflowErrorStore(
  transact: Transact,
): WorkflowErrorDatabase {
  return Object.freeze({
    listTargets: (input) => listErrorWorkflowTargets(transact, input),
    readSettings: (input) => readErrorWorkflowSettings(transact, input),
    updateSettings: (input) => updateErrorWorkflowSettings(transact, input),
  } satisfies WorkflowErrorDatabase);
}

function listErrorWorkflowTargets(
  transact: Transact,
  input: Parameters<WorkflowErrorDatabase['listTargets']>[0],
): ReturnType<WorkflowErrorDatabase['listTargets']> {
  return transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
        actorId: input.actorId,
        roles: rolesForCapability('workflow:update'),
      });
      const access = await readFolderScope(client, input);
      if (
        !(await workflowAccessible(client, access, {
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          capability: 'workflow:update',
        }))
      )
        throw new WorkflowNotFoundError('Workflow is not visible');
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
            input.after === undefined
              ? undefined
              : gt(workflows.id, input.after),
            sql`${workflowVersions.executableJson}::jsonb @> '{"graph":{"nodes":[{"definition":{"key":"core.workflow_error","version":1}}]}}'::jsonb`,
          ),
        )
        .orderBy(asc(workflows.id))
        .limit(51)
        .catch(rethrowQueryFailure);
      const page = rows.slice(0, 50);
      return {
        items: page
          .filter((row) => isWorkflowErrorTarget(row.graph))
          .map((row) => ({ id: row.id, name: row.name })),
        nextCursor: rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
      };
    },
    input.signal,
  );
}

function readErrorWorkflowSettings(
  transact: Transact,
  input: Parameters<WorkflowErrorDatabase['readSettings']>[0],
): ReturnType<WorkflowErrorDatabase['readSettings']> {
  return transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
        actorId: input.actorId,
        roles: rolesForCapability('workflow:read'),
      });
      const access = await readFolderScope(client, input);
      if (
        !(await workflowAccessible(client, access, {
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          capability: 'workflow:read',
        }))
      )
        throw new WorkflowNotFoundError('Workflow is not visible');
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
    },
    input.signal,
  );
}

function updateErrorWorkflowSettings(
  transact: Transact,
  input: Parameters<WorkflowErrorDatabase['updateSettings']>[0],
): ReturnType<WorkflowErrorDatabase['updateSettings']> {
  return transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
        actorId: input.actorId,
        roles: rolesForCapability('workflow:update'),
      });
      const access = await readFolderScope(client, input);
      if (
        !(await workflowAccessible(client, access, {
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          capability: 'workflow:update',
        }))
      )
        throw new WorkflowNotFoundError('Workflow is not visible');
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
      await db
        .insert(auditEvents)
        .values({
          id: generatePersistedId(),
          workspaceId: input.workspaceId,
          actorUserId: input.actorId,
          action: 'workflow.error_policy_updated',
          targetType: 'workflow',
          targetId: input.workflowId,
          requestId: input.requestId ?? null,
          traceId: input.traceId ?? null,
          metadata: { targetWorkflowId: settings.targetWorkflowId },
        })
        .catch(rethrowQueryFailure);
      await completeCommand(client, identity, settings);
      return { settings, replayed: false };
    },
    input.signal,
  );
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

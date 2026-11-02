import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import type { WorkflowConcurrencySettings as ConcurrencySettings } from '@pertexo/contracts';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { entitlementPolicyState } from '../../../runs/queries/entitlement-effect.js';
import {
  workflowConcurrencyPolicies,
  workflows,
  usageEvents,
  workspaces,
  workspaceExecutionEntitlements,
  workspaceExecutionEntitlementVersions,
} from '@pertexo/database/schema';

import { RUN_SUMMARY_RETENTION_SQL } from '../../../runs/data-policy.js';
import type { AuthoringAccess, WorkflowActor } from '../../workflows/access.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';

const RECENT_SKIPS_SHOWN = 20;

export type WorkflowConcurrencySettings = ConcurrencySettings;
export type WorkflowConcurrencyScope = WorkflowActor;
export type UpdateWorkflowConcurrencyInput = WorkflowConcurrencyScope &
  Readonly<{
    limit: number | null;
    overflow?: 'queue' | 'skip';
    expectedRevision: number;
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
  }>;
export class WorkflowConcurrencyRevisionConflictError extends Error {
  public override readonly name = 'WorkflowConcurrencyRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow concurrency revision does not match');
  }
}
export class WorkflowConcurrencyLimitUnavailableError extends Error {
  public override readonly name = 'WorkflowConcurrencyLimitUnavailableError';
  public constructor() {
    super('Active workspace entitlement required');
  }
}
export class WorkflowConcurrencyLimitExceededError extends Error {
  public override readonly name = 'WorkflowConcurrencyLimitExceededError';
  public constructor(public readonly maximum: number) {
    super('Workflow concurrency limit exceeds workspace capacity');
  }
}
/** The workspace's current execution entitlement, as the settings show it. */
async function readEntitlement(client: PoolClient, workspaceId: string) {
  const current = workspaceExecutionEntitlements,
    version = workspaceExecutionEntitlementVersions;
  const [row] = await drizzle(client)
    .select({
      asOf: sql<string>`to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      state: sql<
        WorkflowConcurrencySettings['workspacePolicyState']
      >`case when ${version.version} is null then 'unavailable' else ${entitlementPolicyState(version, sql`clock_timestamp()`)} end`,
      maximum: version.activeRunLimit,
    })
    .from(workspaces)
    .leftJoin(current, eq(current.workspaceId, workspaces.id))
    .leftJoin(
      version,
      and(
        eq(version.workspaceId, current.workspaceId),
        eq(version.version, current.currentVersion),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new Error('Entitlement read returned no row');
  return {
    asOf: row.asOf,
    state: row.state,
    maximum: row.state === 'active' ? row.maximum : null,
  };
}

async function readPolicy(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const [row] = await drizzle(client)
    .select({
      limit: workflowConcurrencyPolicies.activeRunLimit,
      revision: workflowConcurrencyPolicies.revision,
      overflow: workflowConcurrencyPolicies.overflow,
    })
    .from(workflowConcurrencyPolicies)
    .where(
      and(
        eq(workflowConcurrencyPolicies.workspaceId, workspaceId),
        eq(workflowConcurrencyPolicies.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  // A workflow without a policy has no limit, at revision 1.
  return {
    limit: row?.limit ?? null,
    revision: row?.revision ?? 1,
    overflow: row?.overflow ?? 'queue',
  };
}

async function requireWorkflow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const workflow = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  if (workflow.length !== 1)
    throw new WorkflowNotFoundError('Concurrency settings are not visible');
}

function settingsOf(
  policy: Readonly<{
    limit: number | null;
    revision: number;
    overflow: 'queue' | 'skip';
  }>,
  entitlement: Awaited<ReturnType<typeof readEntitlement>>,
): WorkflowConcurrencySettings {
  return {
    asOf: entitlement.asOf,
    limit: policy.limit,
    revision: policy.revision,
    workspaceActiveRunLimit: entitlement.maximum,
    workspacePolicyState: entitlement.state,
    overflow: policy.overflow,
  };
}

export type WorkflowConcurrencyStore = ReturnType<
  typeof createWorkflowConcurrencyStore
>;

/** Workflow active-run limits, sharing the authoring factory's transactions. */
export function createWorkflowConcurrencyStore(access: AuthoringAccess) {
  return Object.freeze({
    readSettings: (input: WorkflowConcurrencyScope) =>
      access.workflow(
        input,
        {
          capability: 'workflow:read',
          statuses: BROWSABLE_WORKSPACE_STATUSES,
        },
        (client) => readConcurrencySettings(client, input),
      ),
    updateSettings: (input: UpdateWorkflowConcurrencyInput) =>
      access.workflow(input, { capability: 'workflow:update' }, (client) =>
        updateConcurrencySettings(client, input),
      ),
  });
}

async function readConcurrencySettings(
  client: PoolClient,
  input: WorkflowConcurrencyScope,
): Promise<WorkflowConcurrencySettings> {
  const { workspaceId, workflowId } = input;
  await requireWorkflow(client, workspaceId, workflowId);
  const policy = settingsOf(
    await readPolicy(client, workspaceId, workflowId),
    await readEntitlement(client, workspaceId),
  );
  const recentSkips = await drizzle(client)
    .select({
      id: usageEvents.id,
      at: sql<string>`to_char(${usageEvents.occurredAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      triggerType: sql<
        NonNullable<
          WorkflowConcurrencySettings['recentSkips']
        >[number]['triggerType']
      >`${usageEvents.metadata}->>'triggerType'`,
      reason: sql<
        NonNullable<
          WorkflowConcurrencySettings['recentSkips']
        >[number]['reason']
      >`${usageEvents.metadata}->>'reason'`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.workspaceId, workspaceId),
        eq(usageEvents.resourceType, 'workflow'),
        eq(usageEvents.resourceId, workflowId),
        eq(usageEvents.category, 'trigger.skipped'),
        gt(
          usageEvents.occurredAt,
          sql`statement_timestamp()-${RUN_SUMMARY_RETENTION_SQL}`,
        ),
      ),
    )
    .orderBy(
      sql`${usageEvents.occurredAt} desc nulls last`,
      asc(usageEvents.id),
    )
    .limit(RECENT_SKIPS_SHOWN)
    .catch(rethrowQueryFailure);
  return { ...policy, recentSkips };
}

async function updateConcurrencySettings(
  client: PoolClient,
  input: UpdateWorkflowConcurrencyInput,
): Promise<
  Readonly<{ settings: WorkflowConcurrencySettings; replayed: boolean }>
> {
  const { workspaceId, actorId, workflowId } = input;
  const request = {
    limit: input.limit,
    expectedRevision: input.expectedRevision,
    ...(input.overflow === undefined ? {} : { overflow: input.overflow }),
  };
  await requireWorkflow(client, workspaceId, workflowId);
  const identity = {
    workspaceId,
    operation: 'workflow.concurrency',
    scope: `${actorId}:${workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const stored = await claimCommand<WorkflowConcurrencySettings>(client, {
    ...identity,
    request,
    resourceId: workflowId,
  });
  if (stored !== null)
    return Object.freeze({
      settings: stored,
      replayed: true,
    });
  // Run grants read the limit under the workspace's admission counter.
  await drizzle(client)
    .execute(sql`select app.lock_workspace_admission(${workspaceId})`)
    .catch(rethrowQueryFailure);
  const entitlement = await readEntitlement(client, workspaceId);
  const policy = await readPolicy(client, workspaceId, workflowId);
  if (policy.revision !== request.expectedRevision)
    throw new WorkflowConcurrencyRevisionConflictError(policy.revision);
  if (request.limit !== null) {
    if (entitlement.maximum === null)
      throw new WorkflowConcurrencyLimitUnavailableError();
    if (request.limit > entitlement.maximum)
      throw new WorkflowConcurrencyLimitExceededError(entitlement.maximum);
  }
  let current = policy;
  const overflow = request.overflow ?? policy.overflow;
  if (policy.limit !== request.limit || policy.overflow !== overflow) {
    current = {
      limit: request.limit,
      revision: policy.revision + 1,
      overflow,
    };
    const db = drizzle(client);
    await db
      .insert(workflowConcurrencyPolicies)
      .values({
        workspaceId,
        workflowId,
        activeRunLimit: current.limit,
        revision: current.revision,
        overflow: current.overflow,
      })
      .onConflictDoUpdate({
        target: [
          workflowConcurrencyPolicies.workspaceId,
          workflowConcurrencyPolicies.workflowId,
        ],
        set: {
          activeRunLimit: sql`excluded.active_run_limit`,
          revision: sql`excluded.revision`,
          overflow: sql`excluded.overflow`,
        },
      })
      .catch(rethrowQueryFailure);
    await appendAuditFact(client, {
      workspaceId,
      actorId: actorId,
      action: 'workflow.concurrency_settings_changed',
      targetType: 'workflow',
      targetId: workflowId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: {
        limit: current.limit,
        revision: current.revision,
        overflow: current.overflow,
      },
    });
  }
  const result = settingsOf(current, entitlement);
  await completeCommand(client, identity, result);
  return Object.freeze({ settings: result, replayed: false });
}

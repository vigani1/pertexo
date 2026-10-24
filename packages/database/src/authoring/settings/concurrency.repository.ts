import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../schema/authoring/workflows.js';
import { workflowConcurrencyPolicies } from '../../schema/authoring/concurrency.js';
import {
  workspaceExecutionEntitlements,
  workspaceExecutionEntitlementVersions,
} from '../../schema/runs/capacity/entitlements.js';
import {
  workspaces,
  auditEvents,
  usageEvents,
} from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { WORKFLOW_EDITOR_ROLES } from '@pertexo/workflow-model';
import type { WorkflowConcurrencySettings as ConcurrencySettings } from '@pertexo/contracts';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { RUN_SUMMARY_RETENTION_SQL } from '../../runs/data-policy.js';
import { ROLES, type Role } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';

const revision = z.number().int().min(1).max(2_147_483_647);
const limit = z.number().int().min(1).max(10_000).nullable();
export type WorkflowConcurrencySettings = ConcurrencySettings;
type Scope = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export interface WorkflowConcurrencyDatabase {
  readSettings(input: Scope): Promise<WorkflowConcurrencySettings>;
  updateSettings(
    input: Scope &
      Readonly<{
        limit: number | null;
        overflow?: 'queue' | 'skip';
        expectedRevision: number;
        idempotencyKey: string;
        requestId?: string;
        traceId?: string;
      }>,
  ): Promise<
    Readonly<{ settings: WorkflowConcurrencySettings; replayed: boolean }>
  >;
}
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
type Transact = <T>(
  workspaceId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

const EDITORS: readonly Role[] = WORKFLOW_EDITOR_ROLES;

/** The workspace's current execution entitlement, as the settings show it. */
async function readEntitlement(client: PoolClient, workspaceId: string) {
  const current = workspaceExecutionEntitlements,
    version = workspaceExecutionEntitlementVersions;
  const [row] = await drizzle(client)
    .select({
      asOf: sql<string>`to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      state: sql<
        WorkflowConcurrencySettings['workspacePolicyState']
      >`case when ${version.version} is null then 'unavailable' when ${version.status}='suspended' then 'suspended' when ${version.effectiveAt}>clock_timestamp() then 'not_yet_effective' when ${version.expiresAt}<=clock_timestamp() then 'expired' else 'active' end`,
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

/** Workflow active-run limits, sharing the authoring factory's transactions. */
export function createWorkflowConcurrencyStore(
  transact: Transact,
): WorkflowConcurrencyDatabase {
  return Object.freeze({
    readSettings: (input) => readConcurrencySettings(transact, input),

    updateSettings: (input) => updateConcurrencySettings(transact, input),
  } satisfies WorkflowConcurrencyDatabase);
}

async function readConcurrencySettings(
  transact: Transact,
  input: Parameters<WorkflowConcurrencyDatabase['readSettings']>[0],
): ReturnType<WorkflowConcurrencyDatabase['readSettings']> {
  const workspaceId = z.uuid().parse(input.workspaceId),
    actorId = z.uuid().parse(input.actorId),
    workflowId = z.uuid().parse(input.workflowId);
  return transact(
    workspaceId,
    actorId,
    async (client) => {
      await lockWorkflowAuthoringAuthority(client, workspaceId, {
        actorId,
        roles: ROLES,
        resource: { workflowId, capability: 'workflow:read' },
      });
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
        .limit(20)
        .catch(rethrowQueryFailure);
      return { ...policy, recentSkips };
    },
    input.signal,
  );
}

async function updateConcurrencySettings(
  transact: Transact,
  input: Parameters<WorkflowConcurrencyDatabase['updateSettings']>[0],
): ReturnType<WorkflowConcurrencyDatabase['updateSettings']> {
  const workspaceId = z.uuid().parse(input.workspaceId),
    actorId = z.uuid().parse(input.actorId),
    workflowId = z.uuid().parse(input.workflowId);
  const request = {
    limit: limit.parse(input.limit),
    expectedRevision: revision.parse(input.expectedRevision),
    ...(input.overflow === undefined
      ? {}
      : { overflow: z.enum(['queue', 'skip']).parse(input.overflow) }),
  };
  return transact(
    workspaceId,
    actorId,
    async (client) => {
      await lockWorkflowAuthoringAuthority(client, workspaceId, {
        actorId,
        roles: EDITORS,
        resource: { workflowId, capability: 'workflow:update' },
      });
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
        await db
          .insert(auditEvents)
          .values({
            id: generatePersistedId(),
            workspaceId,
            actorUserId: actorId,
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
          })
          .catch(rethrowQueryFailure);
      }
      const result = settingsOf(current, entitlement);
      await completeCommand(client, identity, result);
      return Object.freeze({ settings: result, replayed: false });
    },
    input.signal,
  );
}

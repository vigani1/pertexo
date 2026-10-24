import { bindResourcePredicate } from '../../tenant-access/resources/query-scope.js';
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
  const result = await client.query<{
    as_of: string;
    state: WorkflowConcurrencySettings['workspacePolicyState'];
    active_run_limit: number | null;
  }>(
    `select to_char(clock_timestamp() at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as_of,
            case when version.version is null then 'unavailable'
                 when version.status = 'suspended' then 'suspended'
                 when version.effective_at > clock_timestamp() then 'not_yet_effective'
                 when version.expires_at <= clock_timestamp() then 'expired'
                 else 'active' end state,
            version.active_run_limit
     from (select 1) now
     left join app.workspace_execution_entitlements current
       on current.workspace_id = $1
     left join app.workspace_execution_entitlement_versions version
       on version.workspace_id = current.workspace_id
      and version.version = current.current_version`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Entitlement read returned no row');
  return {
    asOf: row.as_of,
    state: row.state,
    maximum: row.state === 'active' ? row.active_run_limit : null,
  };
}

async function readPolicy(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const result = await client.query<{
    active_run_limit: number | null;
    revision: number;
    overflow: 'queue' | 'skip';
  }>(
    `select active_run_limit, revision, overflow from app.workflow_concurrency_policies
     where workspace_id = $1 and workflow_id = $2`,
    [workspaceId, workflowId],
  );
  const row = result.rows[0];
  // A workflow without a policy has no limit, at revision 1.
  return {
    limit: row?.active_run_limit ?? null,
    revision: row?.revision ?? 1,
    overflow: row?.overflow ?? 'queue',
  };
}

async function requireWorkflow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const workflow = await client.query(
    'select 1 from app.workflows where workspace_id = $1 and id = $2 for share',
    [workspaceId, workflowId],
  );
  if (workflow.rowCount !== 1)
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
      const history = await client.query<{
        id: string;
        at: string;
        trigger_type: NonNullable<
          WorkflowConcurrencySettings['recentSkips']
        >[number]['triggerType'];
        reason: NonNullable<
          WorkflowConcurrencySettings['recentSkips']
        >[number]['reason'];
      }>(
        `select id,to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,
                    metadata->>'triggerType' trigger_type,metadata->>'reason' reason
             from app.usage_events where workspace_id=$1 and resource_type='workflow' and resource_id=$2
               and category='trigger.skipped' and occurred_at>statement_timestamp()-${bindResourcePredicate(RUN_SUMMARY_RETENTION_SQL.inlineParams(), [])}
             order by occurred_at desc nulls last,id limit 20`,
        [workspaceId, workflowId],
      );
      return {
        ...policy,
        recentSkips: history.rows.map((row) => ({
          id: row.id,
          at: row.at,
          triggerType: row.trigger_type,
          reason: row.reason,
        })),
      };
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
      await client.query('select app.lock_workspace_admission($1)', [
        workspaceId,
      ]);
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
        await client.query(
          `insert into app.workflow_concurrency_policies
                 (workspace_id, workflow_id, active_run_limit, revision, overflow)
               values ($1, $2, $3, $4, $5)
               on conflict (workspace_id, workflow_id) do update
               set active_run_limit = excluded.active_run_limit,
                   revision = excluded.revision, overflow = excluded.overflow`,
          [
            workspaceId,
            workflowId,
            current.limit,
            current.revision,
            current.overflow,
          ],
        );
        await client.query(
          `insert into app.audit_events
                 (id, workspace_id, actor_user_id, action, target_type, target_id,
                  request_id, trace_id, metadata)
               values ($1, $2, $3, 'workflow.concurrency_settings_changed', 'workflow',
                       $4, $5, $6, $7::jsonb)`,
          [
            generatePersistedId(),
            workspaceId,
            actorId,
            workflowId,
            input.requestId ?? null,
            input.traceId ?? null,
            JSON.stringify({
              limit: current.limit,
              revision: current.revision,
              overflow: current.overflow,
            }),
          ],
        );
      }
      const result = settingsOf(current, entitlement);
      await completeCommand(client, identity, result);
      return Object.freeze({ settings: result, replayed: false });
    },
    input.signal,
  );
}

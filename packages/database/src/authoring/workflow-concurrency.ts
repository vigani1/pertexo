import type { PoolClient } from 'pg';
import { z } from 'zod';

import { claimCommand, completeCommand } from '../platform/idempotency.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { ROLES, type Role } from '../tenant-access/workspace-policy.js';
import { lockWorkflowAuthoringAuthority } from './workflow-authoring-authority.js';
import { WorkflowNotFoundError } from './workflow-authoring-errors.js';

const revision = z.number().int().min(1).max(2_147_483_647);
const limit = z.number().int().min(1).max(10_000).nullable();
const settings = z
  .object({
    asOf: z.iso.datetime({ precision: 6 }),
    limit,
    revision,
    workspaceActiveRunLimit: limit,
    workspacePolicyState: z.enum([
      'active',
      'suspended',
      'not_yet_effective',
      'expired',
      'unavailable',
    ]),
    overflow: z.literal('queue'),
  })
  .strict();
export type WorkflowConcurrencySettings = z.infer<typeof settings>;
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

const EDITORS: readonly Role[] = ['owner', 'admin', 'builder'];

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
  }>(
    `select active_run_limit, revision from app.workflow_concurrency_policies
     where workspace_id = $1 and workflow_id = $2`,
    [workspaceId, workflowId],
  );
  const row = result.rows[0];
  // A workflow without a policy has no limit, at revision 1.
  return { limit: row?.active_run_limit ?? null, revision: row?.revision ?? 1 };
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
  policy: Readonly<{ limit: number | null; revision: number }>,
  entitlement: Awaited<ReturnType<typeof readEntitlement>>,
): WorkflowConcurrencySettings {
  return settings.parse({
    asOf: entitlement.asOf,
    limit: policy.limit,
    revision: policy.revision,
    workspaceActiveRunLimit: entitlement.maximum,
    workspacePolicyState: entitlement.state,
    overflow: 'queue',
  });
}

/** Workflow active-run limits, sharing the authoring factory's transactions. */
export function createWorkflowConcurrencyStore(
  transact: Transact,
): WorkflowConcurrencyDatabase {
  return Object.freeze({
    readSettings: async (input) => {
      const workspaceId = z.uuid().parse(input.workspaceId),
        actorId = z.uuid().parse(input.actorId),
        workflowId = z.uuid().parse(input.workflowId);
      return transact(
        workspaceId,
        actorId,
        async (client) => {
          await lockWorkflowAuthoringAuthority(
            client,
            workspaceId,
            actorId,
            ROLES,
          );
          await requireWorkflow(client, workspaceId, workflowId);
          return settingsOf(
            await readPolicy(client, workspaceId, workflowId),
            await readEntitlement(client, workspaceId),
          );
        },
        input.signal,
      );
    },

    updateSettings: async (input) => {
      const workspaceId = z.uuid().parse(input.workspaceId),
        actorId = z.uuid().parse(input.actorId),
        workflowId = z.uuid().parse(input.workflowId);
      const request = {
        limit: limit.parse(input.limit),
        expectedRevision: revision.parse(input.expectedRevision),
      };
      return transact(
        workspaceId,
        actorId,
        async (client) => {
          await lockWorkflowAuthoringAuthority(
            client,
            workspaceId,
            actorId,
            EDITORS,
          );
          await requireWorkflow(client, workspaceId, workflowId);
          const identity = {
            workspaceId,
            operation: 'workflow.concurrency',
            scope: `${actorId}:${workflowId}`,
            idempotencyKey: input.idempotencyKey,
          };
          const stored = await claimCommand(client, {
            ...identity,
            request,
            resourceId: workflowId,
          });
          if (stored !== null)
            return Object.freeze({
              settings: settings.parse(stored),
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
              throw new WorkflowConcurrencyLimitExceededError(
                entitlement.maximum,
              );
          }
          let current = policy;
          if (policy.limit !== request.limit) {
            current = { limit: request.limit, revision: policy.revision + 1 };
            await client.query(
              `insert into app.workflow_concurrency_policies
                 (workspace_id, workflow_id, active_run_limit, revision)
               values ($1, $2, $3, $4)
               on conflict (workspace_id, workflow_id) do update
               set active_run_limit = excluded.active_run_limit,
                   revision = excluded.revision`,
              [workspaceId, workflowId, current.limit, current.revision],
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
                  overflow: 'queue',
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
    },
  } satisfies WorkflowConcurrencyDatabase);
}

import type { PoolClient } from 'pg';
import { isWorkflowErrorTarget } from '@pertexo/workflow-model';
import {
  workflowErrorSettingsSchema,
  type WorkflowErrorSettings,
  type WorkflowErrorSettingsRequest,
  type WorkflowErrorTargetsPage,
} from '@pertexo/contracts';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { rolesForCapability } from '../../tenant-access/policy.js';

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
async function readPolicy(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowErrorSettings> {
  const found = await client.query<{
    target_workflow_id: string | null;
    target_name: string | null;
    revision: number;
  }>(
    'select policy.target_workflow_id,policy.revision,target.name target_name from app.workflow_error_policies policy left join app.workflows target on target.workspace_id=policy.workspace_id and target.id=policy.target_workflow_id where policy.workspace_id=$1 and policy.workflow_id=$2',
    [workspaceId, workflowId],
  );
  return {
    targetWorkflowId: found.rows[0]?.target_workflow_id ?? null,
    revision: found.rows[0]?.revision ?? 1,
    targetWorkflowName: found.rows[0]?.target_name ?? null,
  };
}

/** Operational Settings share the authoring transaction and current authority fence. */
export function createWorkflowErrorStore(
  transact: Transact,
): WorkflowErrorDatabase {
  return Object.freeze({
    listTargets: (input) =>
      transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await lockWorkflowAuthoringAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('workflow:update'),
          );
          const source = await client.query(
            'select 1 from app.workflows where workspace_id=$1 and id=$2',
            [input.workspaceId, input.workflowId],
          );
          if (source.rowCount !== 1)
            throw new WorkflowNotFoundError('Workflow is not visible');
          const rows = await client.query<{
            id: string;
            name: string;
            graph: unknown;
          }>(
            `select workflow.id,workflow.name,version.executable_json->'graph' graph from app.workflows workflow join app.workflow_versions version on version.workspace_id=workflow.workspace_id and version.id=workflow.published_version_id
        where workflow.workspace_id=$1 and workflow.id<>$2 and workflow.lifecycle_status='active'
        and ($3::uuid is null or workflow.id>$3)
        and version.executable_json::jsonb @> '{"graph":{"nodes":[{"definition":{"key":"core.workflow_error","version":1}}]}}'::jsonb
        order by workflow.id limit 51`,
            [input.workspaceId, input.workflowId, input.after ?? null],
          );
          const page = rows.rows.slice(0, 50);
          return {
            items: page
              .filter((row) => isWorkflowErrorTarget(row.graph))
              .map((row) => ({ id: row.id, name: row.name })),
            nextCursor:
              rows.rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
          };
        },
        input.signal,
      ),
    readSettings: (input) =>
      transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await lockWorkflowAuthoringAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('workflow:read'),
          );
          const source = await client.query(
            'select id from app.workflows where workspace_id=$1 and id=$2 for share',
            [input.workspaceId, input.workflowId],
          );
          if (source.rowCount !== 1)
            throw new WorkflowNotFoundError('Workflow is not visible');
          return readPolicy(client, input.workspaceId, input.workflowId);
        },
        input.signal,
      ),
    updateSettings: (input) =>
      transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await lockWorkflowAuthoringAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('workflow:update'),
          );
          // Stable order also covers two editors choosing each other's workflows.
          const ids = [
            ...new Set([
              input.workflowId,
              ...(input.targetWorkflowId === null
                ? []
                : [input.targetWorkflowId]),
            ]),
          ].sort();
          const locked = await client.query<{
            id: string;
            lifecycle_status: string;
          }>(
            'select id,lifecycle_status from app.workflows where workspace_id=$1 and id=any($2::uuid[]) order by id for update',
            [input.workspaceId, ids],
          );
          if (locked.rows.length !== ids.length)
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
          const replay = await claimCommand(client, {
            ...identity,
            request,
            resourceId: input.workflowId,
          });
          if (replay !== null)
            return {
              settings: workflowErrorSettingsSchema.parse(replay),
              replayed: true,
            };
          const policy = await readPolicy(
            client,
            input.workspaceId,
            input.workflowId,
          );
          if (policy.revision !== input.expectedRevision)
            throw new WorkflowErrorSettingsConflictError(policy.revision);
          if (input.targetWorkflowId !== null) {
            if (input.targetWorkflowId === input.workflowId)
              throw new WorkflowErrorTargetUnavailableError();
            const target = await client.query<{ graph: unknown }>(
              `select version.executable_json->'graph' as graph from app.workflows workflow join app.workflow_versions version on version.workspace_id=workflow.workspace_id and version.id=workflow.published_version_id where workflow.workspace_id=$1 and workflow.id=$2 and workflow.lifecycle_status='active'`,
              [input.workspaceId, input.targetWorkflowId],
            );
            if (!isWorkflowErrorTarget(target.rows[0]?.graph))
              throw new WorkflowErrorTargetUnavailableError();
          }
          const settings = {
            targetWorkflowId: input.targetWorkflowId,
            revision: policy.revision + 1,
          };
          await client.query(
            `insert into app.workflow_error_policies(workspace_id,workflow_id,target_workflow_id,revision) values($1,$2,$3,$4) on conflict(workspace_id,workflow_id) do update set target_workflow_id=excluded.target_workflow_id,revision=excluded.revision`,
            [
              input.workspaceId,
              input.workflowId,
              settings.targetWorkflowId,
              settings.revision,
            ],
          );
          await client.query(
            `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata) values($1,$2,$3,'workflow.error_policy_updated','workflow',$4,$5,$6,$7::jsonb)`,
            [
              generatePersistedId(),
              input.workspaceId,
              input.actorId,
              input.workflowId,
              input.requestId ?? null,
              input.traceId ?? null,
              JSON.stringify({ targetWorkflowId: settings.targetWorkflowId }),
            ],
          );
          await completeCommand(client, identity, settings);
          return { settings, replayed: false };
        },
        input.signal,
      ),
  } satisfies WorkflowErrorDatabase);
}

import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Role } from '@pertexo/workflow-model';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';
import type {
  AutoPauseCommandResult,
  Transact,
  CommandInput,
} from './contract.js';
import { lockWorkspace, type WorkspaceRow } from './state.queries.js';
/**
 * One settings command: the actor's role, then an exact retry's first
 * result, then the change and its audit event when anything changed.
 */
export function command<T>(
  transact: Transact,
  input: CommandInput,
  options: Readonly<{
    /** The workspace lock every auto-pause command takes first. */
    exclusive: boolean;
    operation: string;
    resourceId: string;
    workflowId?: string;
    roles: readonly Role[];
    request: unknown;
    schema: z.ZodType<T>;
    apply: (
      client: PoolClient,
      workspace: WorkspaceRow,
    ) => Promise<
      Readonly<{
        settings: T;
        audit?: Readonly<{ action: string; targetType: string }>;
      }>
    >;
  }>,
): Promise<AutoPauseCommandResult<T>> {
  const workspaceId = z.uuid().parse(input.workspaceId);
  const actorId = z.uuid().parse(input.actorId);
  return transact(workspaceId, actorId, async (client) => {
    const workspace = await lockWorkspace(client, workspaceId, {
      exclusive: options.exclusive,
    });
    await lockWorkflowAuthoringAuthority(client, workspaceId, {
      actorId,
      roles: options.roles,
      resource:
        options.workflowId === undefined
          ? undefined
          : { workflowId: options.workflowId, capability: 'workflow:update' },
    });
    const identity = {
      workspaceId,
      operation: options.operation,
      scope: `${actorId}:${options.resourceId}`,
      idempotencyKey: input.idempotencyKey,
    };
    const stored = await claimCommand(client, {
      ...identity,
      request: options.request,
      resourceId: options.resourceId,
    });
    if (stored !== null)
      return Object.freeze({
        settings: options.schema.parse(stored),
        replayed: true,
      });
    const { settings, audit } = await options.apply(client, workspace);
    if (audit !== undefined)
      await client.query(
        `insert into app.audit_events
             (id, workspace_id, actor_user_id, action, target_type, target_id,
              request_id, trace_id, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          generatePersistedId(),
          workspaceId,
          actorId,
          audit.action,
          audit.targetType,
          options.resourceId,
          input.requestId ?? null,
          input.traceId ?? null,
          JSON.stringify({ settings }),
        ],
      );
    await completeCommand(client, identity, settings);
    return Object.freeze({ settings, replayed: false });
  });
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { auditEvents } from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Role } from '@pertexo/workflow-model';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
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
      await drizzle(client)
        .insert(auditEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          actorUserId: actorId,
          action: audit.action,
          targetType: audit.targetType,
          targetId: options.resourceId,
          requestId: input.requestId ?? null,
          traceId: input.traceId ?? null,
          metadata: { settings },
        })
        .catch(rethrowQueryFailure);
    await completeCommand(client, identity, settings);
    return Object.freeze({ settings, replayed: false });
  });
}

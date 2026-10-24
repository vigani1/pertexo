import type { WorkflowPromotionTargetResult } from '@pertexo/contracts';
import { hasCapability, type Role } from '@pertexo/workflow-model';
import type { WorkflowPromotionSettings } from '@pertexo/contracts';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import {
  WorkflowPromotionError,
  type PromotionContext,
  type WorkflowPromotionStore,
} from './contract.js';
import {
  lockPromotionWorkspaces,
  readPromotionLink,
  requirePromotionAuthority,
} from './authority.queries.js';

export function promotionSettings(
  context: PromotionContext,
): Pick<WorkflowPromotionStore, 'settings' | 'setTarget'> {
  return {
    settings: (input) => readPromotionSettings(context, input),
    setTarget: (input) => setPromotionTarget(context, input),
  };
}

function readPromotionSettings(
  context: PromotionContext,
  input: Parameters<WorkflowPromotionStore['settings']>[0],
): ReturnType<WorkflowPromotionStore['settings']> {
  return context.transactScopes(async (inWorkspace) => {
    const sourceScope = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
    };
    const initial = await inWorkspace(sourceScope, (client) =>
      readPromotionLink(client, input.workspaceId),
    );
    await lockPromotionWorkspaces(
      inWorkspace,
      input,
      initial.targetWorkspaceId,
    );
    const source = await inWorkspace(sourceScope, async (client) => {
      await requirePromotionAuthority(client, input);
      const link = await readPromotionLink(client, input.workspaceId);
      if (
        link.revision !== initial.revision ||
        link.targetWorkspaceId !== initial.targetWorkspaceId
      )
        throw new WorkflowPromotionError(
          'stale',
          'The promotion target changed. Refresh the settings.',
        );
      const member = (
        await client.query<{ role: Role }>(
          "select role from app.workspace_memberships where workspace_id=$1 and user_id=$2 and status='active'",
          [input.workspaceId, input.actorId],
        )
      ).rows[0];
      return {
        ...link,
        canConfigure:
          member !== undefined &&
          hasCapability(member.role, 'workspace:manage'),
      };
    });
    let target: WorkflowPromotionSettings['target'] = null;
    if (source.targetWorkspaceId !== null) {
      const targetId = source.targetWorkspaceId;
      target = await inWorkspace(
        { workspaceId: targetId, actorId: input.actorId },
        async (client) => {
          try {
            await requirePromotionAuthority(client, {
              ...input,
              workspaceId: targetId,
            });
          } catch (error) {
            if (error instanceof WorkflowNotFoundError)
              return {
                status: 'unavailable' as const,
                workspaceId: targetId,
                reason:
                  'You need edit access to the target workspace to promote.',
              };
            throw error;
          }
          const row = (
            await client.query<{
              name: string;
              require_publish_approval: boolean;
            }>(
              'select name,require_publish_approval from app.workspaces where id=$1',
              [targetId],
            )
          ).rows[0];
          if (row === undefined)
            throw new WorkflowPromotionError(
              'unavailable',
              'The target workspace is unavailable.',
            );
          return {
            status: 'available' as const,
            workspaceId: targetId,
            name: row.name,
            requireApproval: row.require_publish_approval,
          };
        },
      );
    }
    return {
      revision: source.revision,
      canConfigure: source.canConfigure,
      target,
    };
  }, input.signal);
}

function setPromotionTarget(
  context: PromotionContext,
  input: Parameters<WorkflowPromotionStore['setTarget']>[0],
): ReturnType<WorkflowPromotionStore['setTarget']> {
  return context.transactScopes(async (inWorkspace) => {
    if (input.targetWorkspaceId === input.workspaceId)
      throw new WorkflowPromotionError(
        'incompatible',
        'Choose another workspace as the promotion target.',
      );
    await lockPromotionWorkspaces(inWorkspace, input, input.targetWorkspaceId);
    await inWorkspace(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      (client) => requirePromotionAuthority(client, input, 'workspace:manage'),
    );
    if (input.targetWorkspaceId !== null)
      await inWorkspace(
        { workspaceId: input.targetWorkspaceId, actorId: input.actorId },
        (client) =>
          requirePromotionAuthority(client, {
            ...input,
            workspaceId: input.targetWorkspaceId ?? input.workspaceId,
          }),
      );
    return inWorkspace(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (client) => {
        const identity = {
          workspaceId: input.workspaceId,
          operation: 'workspace.promotion.target',
          scope: input.actorId,
          idempotencyKey: input.idempotencyKey,
        };
        const stored = await claimCommand<WorkflowPromotionTargetResult>(
          client,
          {
            ...identity,
            resourceId: input.workspaceId,
            request: {
              expectedRevision: input.expectedRevision,
              expectedTargetWorkspaceId: input.expectedTargetWorkspaceId,
              targetWorkspaceId: input.targetWorkspaceId,
            },
          },
        );
        if (stored !== null)
          return {
            ...stored,
            replayed: true,
          };
        const current = await readPromotionLink(client, input.workspaceId);
        if (
          current.revision !== input.expectedRevision ||
          current.targetWorkspaceId !== input.expectedTargetWorkspaceId
        )
          throw new WorkflowPromotionError(
            'stale',
            'The promotion target changed. Refresh the settings first.',
          );
        const revision = current.revision + 1;
        await client.query(
          `insert into app.workspace_promotion_targets(workspace_id,target_workspace_id,revision,updated_by)
          values($1,$2,$3,$4) on conflict(workspace_id) do update set target_workspace_id=excluded.target_workspace_id,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
          [input.workspaceId, input.targetWorkspaceId, revision, input.actorId],
        );
        await appendAuditFact(client, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: 'workspace.promotion_target_changed',
          targetType: 'workspace',
          targetId: input.workspaceId,
          requestId: input.requestId ?? null,
          traceId: input.traceId ?? null,
          metadata: {
            targetWorkspaceId: input.targetWorkspaceId,
            revision,
          },
        });
        const result = {
          replayed: false,
          revision,
          targetWorkspaceId: input.targetWorkspaceId,
        };
        await completeCommand(client, identity, result);
        return result;
      },
    );
  }, input.signal);
}

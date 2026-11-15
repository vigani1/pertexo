import {
  readWorkspaceNaming,
  lockPromotionWorkspaces,
  readPromotionLink,
  requirePromotionAuthority,
} from './authority.repository.js';

import {
  readActiveMemberRole,
  savePromotionTarget,
} from './settings.repository.js';

import { z } from 'zod';

import { decodeStoredReceipt } from '../../shared/receipts.js';

import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';

import type {
  WorkflowPromotionTargetResult,
  WorkflowPromotionSettings,
} from '@pertexo/contracts';

import { hasCapability } from '@pertexo/policy';

import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';

import { WorkflowPromotionError } from './workflow-promotion.errors.js';

import type {
  PromotionContext,
  PromotionScope,
  SetPromotionTargetInput,
} from './workflow-promotion.types.js';

/** What choosing a target stored. */
const targetReceipt = z.object({
  revision: z.number(),
  targetWorkspaceId: z.uuid().nullable(),
});

export function promotionSettings(context: PromotionContext) {
  return {
    settings: (input: PromotionScope) => readPromotionSettings(context, input),
    setTarget: (input: SetPromotionTargetInput) =>
      setPromotionTarget(context, input),
  };
}

function readPromotionSettings(
  context: PromotionContext,
  input: PromotionScope,
): Promise<WorkflowPromotionSettings> {
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
      await requirePromotionAuthority(client, input, 'workflow:update', {
        browsing: true,
      });
      const link = await readPromotionLink(client, input.workspaceId);
      if (
        link.revision !== initial.revision ||
        link.targetWorkspaceId !== initial.targetWorkspaceId
      )
        throw new WorkflowPromotionError(
          'stale',
          'The promotion target changed. Refresh the settings.',
        );
      const member = await readActiveMemberRole(
        client,
        input.workspaceId,
        input.actorId,
      );
      return {
        ...link,
        canConfigure:
          member !== undefined && hasCapability(member, 'workspace:manage'),
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
          const row = await readWorkspaceNaming(client, targetId);
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
  input: SetPromotionTargetInput,
): Promise<WorkflowPromotionTargetResult> {
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
        if (stored !== null) {
          const result = decodeStoredReceipt(targetReceipt, stored);
          return {
            ...result,
            replayed: true,
          };
        }
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
        await savePromotionTarget(client, input, revision);
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

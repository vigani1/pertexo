import { workspaceReadScope } from '@/lib/api/workspace-scope';
import {
  promotionFailureMessage,
  requiresPromotionReview,
} from '../model/promotion-failures';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  WorkflowPromotionApply,
  WorkflowPromotionPreviewRequest,
  WorkflowPromotionTarget,
} from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { isApiError } from '@/lib/api/error';
import {
  applyPromotion,
  previewPromotion,
  setPromotionTarget,
  type PromotionScope,
} from './promotions.api';
import { promotionKeys, promotionSettingsQuery } from './promotions.queries';

/** Points promotion at a workspace; promotion reads refetch after `onAccepted`. */
export function usePromotionTargetSave(
  scope: PromotionScope,
  onAccepted: (result: Awaited<ReturnType<typeof setPromotionTarget>>) => void,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    (body: WorkflowPromotionTarget, key: string) =>
      setPromotionTarget(scope, body, key),
    async (result) => {
      onAccepted(result);
      await cache.invalidateQueries({ queryKey: promotionKeys.scope(scope) });
    },
    { action: 'saving the promotion target' },
  );
}

export type PromotionReviewInput = Readonly<{
  body: WorkflowPromotionPreviewRequest;
  linkRevision: number;
}>;

/** A dry run of the promotion; its link revision rides along to judge it current. */
export function usePromotionReview(scope: PromotionScope) {
  return useMutation({
    mutationFn: ({ body }: PromotionReviewInput) =>
      previewPromotion(scope, body),
    retry: false,
  });
}

export function usePromotionApply(
  scope: PromotionScope,
  onAccessLost: () => void,
) {
  const cache = useQueryClient();
  const command = useRetainedCommand(
    async (body: WorkflowPromotionApply, key: string) => {
      try {
        return await applyPromotion(scope, body, key);
      } catch (error) {
        if (requiresPromotionReview(error))
          await cache.invalidateQueries({
            queryKey: promotionKeys.scope(scope),
          });
        if (isApiError(error) && [401, 403, 404].includes(error.status ?? 0)) {
          onAccessLost();
          await cache.invalidateQueries({
            queryKey: promotionSettingsQuery(scope).queryKey,
          });
        }
        throw error;
      }
    },
    async (result) => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: promotionKeys.scope(scope) }),
        cache.invalidateQueries({
          queryKey: workspaceReadScope(scope.userId, result.targetWorkspaceId),
        }),
      ]);
    },
    {
      action: 'promoting these workflows',
      failureMessage: promotionFailureMessage,
    },
  );
  return {
    ...command,
    needsReview: !command.uncertain && requiresPromotionReview(command.cause),
  };
}

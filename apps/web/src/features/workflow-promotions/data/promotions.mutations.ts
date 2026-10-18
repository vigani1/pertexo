import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowPromotionApply } from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { isApiError } from '@/lib/api/error';
import { applyPromotion, type PromotionScope } from './promotions.api';
import { promotionKeys, promotionSettingsQuery } from './promotions.queries';

export function usePromotionApply(
  scope: PromotionScope,
  onAccessLost: () => void,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    async (body: WorkflowPromotionApply, key: string) => {
      try {
        return await applyPromotion(scope, body, key);
      } catch (error) {
        if (isApiError(error) && [401, 403, 404].includes(error.status ?? 0)) {
          onAccessLost();
          await cache.invalidateQueries({
            queryKey: promotionSettingsQuery(scope).queryKey,
          });
        }
        throw error;
      }
    },
    async () => {
      await cache.invalidateQueries({ queryKey: promotionKeys.scope(scope) });
    },
    { action: 'promoting these workflows' },
  );
}

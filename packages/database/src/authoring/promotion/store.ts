import type { PromotionContext, WorkflowPromotionStore } from './contract.js';
import { promotionSettings } from './settings.js';
import { promotionReads } from './reads.js';
import { preparePromotion } from './preview.js';
import { applyPromotion } from './apply.js';

export function createWorkflowPromotionStore(
  context: PromotionContext,
): WorkflowPromotionStore {
  const store: WorkflowPromotionStore = {
    ...promotionSettings(context),
    ...promotionReads(context),
    preview: (input) =>
      context.transactScopes(
        (inWorkspace) => preparePromotion(context, inWorkspace, input),
        input.signal,
      ),
    apply: (input) => applyPromotion(context, input),
  };
  return Object.freeze(store);
}

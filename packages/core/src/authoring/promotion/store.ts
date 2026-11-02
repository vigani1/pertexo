import { applyPromotion } from './apply.js';
import type {
  ApplyPromotionInput,
  PreviewPromotionInput,
  PromotionContext,
} from './contract.js';
import { preparePromotion } from './preview.js';
import { promotionReads } from './reads.queries.js';
import { promotionSettings } from './settings.repository.js';

export type WorkflowPromotionStore = ReturnType<
  typeof createWorkflowPromotionStore
>;

export function createWorkflowPromotionStore(context: PromotionContext) {
  return Object.freeze({
    ...promotionSettings(context),
    ...promotionReads(context),
    preview: (input: PreviewPromotionInput) =>
      context.transactScopes(
        (inWorkspace) => preparePromotion(context, inWorkspace, input),
        input.signal,
      ),
    apply: (input: ApplyPromotionInput) => applyPromotion(context, input),
  });
}

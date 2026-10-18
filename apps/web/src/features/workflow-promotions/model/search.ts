import {
  PROMOTION_LIMITS,
  workflowPromotionPreviewRequestSchema,
  type WorkflowPromotionPreviewRequest,
} from '@pertexo/contracts';
const selector = workflowPromotionPreviewRequestSchema.shape.selections.element;
export function promotionSelections(
  selected: string | undefined,
): WorkflowPromotionPreviewRequest['selections'] {
  const seen = new Set<string>();
  return (selected ?? '')
    .split(',')
    .slice(0, PROMOTION_LIMITS.workflows)
    .flatMap((entry) => {
      const [workflowId, versionId] = entry.split(':');
      const parsed = selector.safeParse({ workflowId, versionId });
      if (!parsed.success || seen.has(parsed.data.workflowId)) return [];
      seen.add(parsed.data.workflowId);
      return [parsed.data];
    });
}
export function promotionSearch(
  selections: WorkflowPromotionPreviewRequest['selections'],
) {
  return selections.length === 0
    ? {}
    : {
        selected: selections
          .slice(0, PROMOTION_LIMITS.workflows)
          .map((selection) => `${selection.workflowId}:${selection.versionId}`)
          .join(','),
      };
}
export function parsePromotionSearch(search: Record<string, unknown>) {
  return promotionSearch(
    promotionSelections(
      typeof search.selected === 'string' ? search.selected : undefined,
    ),
  );
}

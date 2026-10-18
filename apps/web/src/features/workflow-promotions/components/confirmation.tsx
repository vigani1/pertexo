import type { ReactNode } from 'react';
import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { PromotionReview } from './review';
export function PromotionConfirmation({
  review,
  current,
  acknowledged,
  locked,
  onAcknowledge,
  renderAction,
}: {
  review: WorkflowPromotionPreview | undefined;
  current: boolean;
  acknowledged: readonly string[];
  locked: boolean;
  onAcknowledge: (id: string, checked: boolean) => void;
  renderAction: (review: WorkflowPromotionPreview) => ReactNode;
}) {
  if (review === undefined) return null;
  return (
    <>
      {current ? null : (
        <Notice tone="warning">
          The target, action or selection changed. Review again before applying.
        </Notice>
      )}
      <PromotionReview
        review={review}
        acknowledged={acknowledged}
        locked={locked}
        onAcknowledge={onAcknowledge}
      />
      {renderAction(review)}
    </>
  );
}

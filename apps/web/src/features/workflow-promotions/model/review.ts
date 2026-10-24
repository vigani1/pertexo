import { canonicalJson } from '@pertexo/workflow-model';
import type {
  WorkflowPromotionMode,
  WorkflowPromotionPreview,
  WorkflowPromotionPreviewRequest,
  WorkflowPromotionSettings,
} from '@pertexo/contracts';
interface ReviewContext {
  body: WorkflowPromotionPreviewRequest;
  linkRevision: number;
}
export function promotionReviewIsCurrent({
  review,
  context,
  settings,
  selections,
  mode,
}: Readonly<{
  review: WorkflowPromotionPreview | undefined;
  context: ReviewContext | undefined;
  settings: WorkflowPromotionSettings | undefined;
  selections: WorkflowPromotionPreviewRequest['selections'];
  mode: WorkflowPromotionMode;
}>): boolean {
  if (
    review === undefined ||
    context === undefined ||
    settings?.target?.status !== 'available'
  )
    return false;
  return (
    context.linkRevision === settings.revision &&
    canonicalJson(context.body.selections) === canonicalJson(selections) &&
    context.body.mode === mode &&
    settings.target.workspaceId === review.targetWorkspaceId &&
    settings.target.requireApproval === review.requireApproval
  );
}
export function promotionActionLabel(mode: WorkflowPromotionMode): string {
  switch (mode) {
    case 'draft':
      return 'Create target drafts';
    case 'publish':
      return 'Publish in target';
    case 'request_approval':
      return 'Request target approval';
  }
}

export function promotionCanApply(
  input: Readonly<{
    review: WorkflowPromotionPreview | undefined;
    current: boolean;
    acknowledged: readonly string[];
    mode: WorkflowPromotionMode;
    note: string;
    completed: boolean;
  }>,
): boolean {
  if (input.completed || !input.current || !input.review?.compatible)
    return false;
  if (input.mode === 'request_approval' && input.note.trim().length === 0)
    return false;
  const ids = new Set(input.acknowledged);
  return input.review.workflows.every(
    (workflow) => !workflow.directChanges || ids.has(workflow.sourceWorkflowId),
  );
}

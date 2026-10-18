import { Link } from '@tanstack/react-router';
import type { WorkflowPromotionResult } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
export function PromotionResult({
  result,
}: {
  result: WorkflowPromotionResult;
}) {
  return (
    <Notice tone="success">
      <p>
        {result.replayed
          ? 'This promotion already completed.'
          : 'Promotion completed.'}
      </p>
      <ul className="mt-2 grid gap-2">
        {result.items.map((item) => (
          <li key={item.targetWorkflowId}>
            <Link
              className="inline-link"
              to="/w/$workspaceId/workflows/$workflowId"
              params={{
                workspaceId: result.targetWorkspaceId,
                workflowId: item.targetWorkflowId,
              }}
            >
              Open target{' '}
              {item.versionNumber === null
                ? `draft r${String(item.revision)}`
                : `v${String(item.versionNumber)}`}
            </Link>
            {item.publicationRequestId === null ? null : (
              <Link
                className="inline-link ml-3"
                to="/w/$workspaceId/publish-reviews/$requestId"
                params={{
                  workspaceId: result.targetWorkspaceId,
                  requestId: item.publicationRequestId,
                }}
              >
                Open publication review
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

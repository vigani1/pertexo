import { Link } from '@tanstack/react-router';
import { describeCommandError } from '@/lib/api/error-copy';
import { promotionFailureMessage } from '../model/promotion-failures';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
export function PromotionCommandFeedback({
  command,
  retryLabel,
  reviewFailure,
  recoveryTargetId,
}: {
  command: Readonly<{
    error: string | undefined;
    uncertain: boolean;
    pending: boolean;
    expired: boolean;
    retry: () => void;
  }>;
  retryLabel: string;
  reviewFailure?: unknown;
  recoveryTargetId?: string | undefined;
}) {
  const message =
    reviewFailure === undefined
      ? command.error
      : (promotionFailureMessage(reviewFailure) ??
        describeCommandError(reviewFailure, 'reviewing this promotion'));
  if (message === undefined && recoveryTargetId === undefined) return null;
  return (
    <>
      {message === undefined ? null : (
        <Notice tone="warning">
          {message}
          {command.uncertain ? (
            <Button
              type="button"
              disabled={command.pending || command.expired}
              onClick={command.retry}
            >
              {retryLabel}
            </Button>
          ) : null}
        </Notice>
      )}
      {recoveryTargetId === undefined ? null : (
        <Link
          to="/w/$workspaceId"
          params={{ workspaceId: recoveryTargetId }}
          className="inline-link self-start"
        >
          Open target workspace
        </Link>
      )}
    </>
  );
}

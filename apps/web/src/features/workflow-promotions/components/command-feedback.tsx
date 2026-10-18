import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
export function PromotionCommandFeedback({
  command,
  retryLabel,
}: {
  command: Readonly<{
    error: string | undefined;
    uncertain: boolean;
    pending: boolean;
    expired: boolean;
    retry: () => void;
  }>;
  retryLabel: string;
}) {
  if (command.error === undefined) return null;
  return (
    <Notice tone="warning">
      {command.error}
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
  );
}

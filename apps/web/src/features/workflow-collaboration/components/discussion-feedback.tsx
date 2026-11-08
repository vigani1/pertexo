import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
export function DiscussionFeedback({
  command,
}: {
  command: {
    error: string | undefined;
    uncertain: boolean;
    expired: boolean;
    pending: boolean;
    retry: () => void;
  };
}) {
  if (command.error === undefined) return null;
  return (
    <Notice tone="warning">
      {command.error}
      {command.uncertain ? (
        <Button
          type="button"
          disabled={command.expired || command.pending}
          onClick={command.retry}
        >
          Retry the same action
        </Button>
      ) : null}
    </Notice>
  );
}

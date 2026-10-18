import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import type { FederationCommandState } from '../data/use-command';
export function CommandFeedback({
  command,
}: Readonly<{ command: FederationCommandState }>) {
  return command.error === undefined ? null : (
    <Notice
      tone="warning"
      action={
        command.uncertain ? (
          <Button
            type="button"
            variant="outline"
            disabled={command.pending || command.expired}
            onClick={() => void command.retry()}
          >
            Retry same request
          </Button>
        ) : undefined
      }
    >
      {command.error}
    </Notice>
  );
}

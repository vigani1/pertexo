import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import type { FederationCommandState } from '../data/use-command';
export function CommandFeedback({
  command,
}: Readonly<{
  command: Pick<
    FederationCommandState,
    'error' | 'pending' | 'uncertain' | 'expired'
  > &
    Readonly<{ retry: (() => void) | (() => Promise<boolean>) }>;
}>) {
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

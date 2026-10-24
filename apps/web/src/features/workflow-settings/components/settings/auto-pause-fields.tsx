import type { AccessibleWorkspace } from '@pertexo/contracts';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import type { useAutoPauseCommand } from '../../data/mutations/use-auto-pause-command';

export type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

export function CommandProblem({
  command,
  onRetrySuccess,
}: Readonly<{
  command: ReturnType<typeof useAutoPauseCommand>;
  onRetrySuccess: () => void;
}>) {
  if (command.problem === undefined) return null;
  return (
    <Notice
      tone={command.unconfirmed ? 'warning' : 'destructive'}
      action={
        command.unconfirmed ? (
          <ProgressButton
            type="button"
            variant="outline"
            pending={command.pending}
            pendingLabel="Retrying…"
            onClick={() => {
              void command.retry().then((saved) => {
                if (saved) onRetrySuccess();
              });
            }}
          >
            Retry same change
          </ProgressButton>
        ) : undefined
      }
    >
      {command.problem}
    </Notice>
  );
}

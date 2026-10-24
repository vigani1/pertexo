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

export function thresholdError({
  value,
  optional = false,
}: Readonly<{ value: string; optional?: boolean | undefined }>):
  string | undefined {
  if (optional && value.trim() === '') return undefined;
  return /^\d+$/u.test(value) && Number(value) >= 3 && Number(value) <= 100
    ? undefined
    : 'Enter a whole number from 3 to 100.';
}

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

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { useWorkflowOrganizationCommand } from '../../use-workflow-organization-command';

export type OrganizationCommand = ReturnType<
  typeof useWorkflowOrganizationCommand
>;

const outcomeLabels = {
  detached: 'Tag detached',
  updated: 'Updated',
  not_visible: 'Not visible',
  conflict: 'Conflict — reload before a new command',
  unavailable: 'Unavailable',
  outcome_unknown: 'Outcome unknown — retry this exact command',
  forbidden: 'Permission lost',
  not_processed: 'Not processed',
};

export function OrganizationCommandFeedback({
  command,
}: Readonly<{ command: OrganizationCommand }>) {
  return (
    <>
      {command.error === undefined ? null : (
        <Notice tone="destructive">{command.error}</Notice>
      )}
      {command.result === undefined ? null : 'items' in command.result ? (
        <Notice title="Cleanup outcomes">
          <ol className="flex flex-col gap-2">
            {command.result.items.map((item) => (
              <li key={item.workflowId}>
                {item.workflowId}: {outcomeLabels[item.status]}
                {'replayed' in item && item.replayed
                  ? ' (previously completed)'
                  : ''}
              </li>
            ))}
          </ol>
          Historical outcomes do not replace current assignments. Reload before
          a new selection or deletion.
        </Notice>
      ) : (
        <Notice tone="success">
          Command completed. Current organization is being reloaded.
        </Notice>
      )}
      {command.retryAvailable ? (
        <ProgressButton
          type="button"
          pending={command.pending}
          pendingLabel="Retrying…"
          onClick={() => {
            void command.retry();
          }}
        >
          Retry exact command
        </ProgressButton>
      ) : null}
      {command.error !== undefined &&
      !command.retryAvailable &&
      !command.denied ? (
        <Button type="button" variant="outline" onClick={command.reset}>
          Dismiss feedback
        </Button>
      ) : null}
    </>
  );
}

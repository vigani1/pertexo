import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

import type { useWorkflowOrganizationCommand } from '../../hooks/organization/use-workflow-organization-command';
export type OrganizationCommand = ReturnType<
  typeof useWorkflowOrganizationCommand
>;
const outcomeLabels = {
  detached: 'Tag detached',
  updated: 'Updated',
  not_visible: 'Not visible',
  conflict: 'Conflict — reload before a new command',
  unavailable: 'Unavailable',
  outcome_unknown: 'Outcome unconfirmed — review the current state',
  forbidden: 'Permission lost',
  not_processed: 'Not processed',
};
export function OrganizationCommandFeedback({
  command,
  names = new Map(),
}: Readonly<{
  command: OrganizationCommand;
  names?: ReadonlyMap<string, string>;
}>) {
  return (
    <>
      {command.error === undefined ? null : (
        <Notice tone="destructive">{command.error}</Notice>
      )}
      <OrganizationResult command={command} names={names} />

      {command.error !== undefined && !command.denied ? (
        <Button type="button" variant="outline" onClick={command.reset}>
          Dismiss feedback
        </Button>
      ) : null}
    </>
  );
}
function OrganizationResult({
  command,
  names,
}: Readonly<{
  command: OrganizationCommand;
  names: ReadonlyMap<string, string>;
}>) {
  if (command.result === undefined) return null;
  if ('items' in command.result)
    return (
      <Notice title="Cleanup outcomes">
        <ol className="flex flex-col gap-2">
          {command.result.items.map((item, index) => (
            <li key={item.workflowId}>
              <span className="break-words">
                {command.denied
                  ? `Workflow name unavailable (${String(index + 1)})`
                  : (names.get(item.workflowId) ??
                    `Workflow name unavailable (${String(index + 1)})`)}
              </span>
              : {outcomeLabels[item.status]}
              {'replayed' in item && item.replayed
                ? ' (previously completed)'
                : ''}
            </li>
          ))}
        </ol>
        Historical outcomes do not replace current assignments. Reload before a
        new selection or deletion.
      </Notice>
    );
  return (
    <Notice tone="success">
      Command completed. Current organization is being reloaded.
    </Notice>
  );
}

import type { AccessibleWorkspace } from '@pertexo/contracts';
import { ArrowRightIcon } from 'lucide-react';
import { Row } from '@/components/patterns/lists/row';
import { Button } from '@/components/ui/button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { WorkspaceMark } from '../shell/workspace-mark';
import { workspaceAvailability } from '../../model/workspace-availability';
import { ROLE_NAMES } from '../../model/role-words';

/**
 * One workspace: its monogram in a thread ring, name, your role, its state
 * and "last opened".
 */
export function WorkspaceCard({
  workspace,
  lastOpened,
  onSelect,
}: Readonly<{
  workspace: AccessibleWorkspace;
  lastOpened: boolean;
  onSelect: (workspace: AccessibleWorkspace) => void;
}>) {
  const availability = workspaceAvailability(workspace);
  return (
    <Row className="grid-cols-[auto_minmax(0,1fr)] gap-x-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <WorkspaceMark name={workspace.name} className="size-10 rounded-lg" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-heading text-section font-semibold wrap-anywhere">
          {workspace.name}
        </span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
          <span>
            {ROLE_NAMES[workspace.role]}
            {lastOpened ? ' · Last opened' : ''}
          </span>
          {workspace.status === 'active' ? null : (
            <StatusMark tone={availability.tone}>
              {availability.status}
            </StatusMark>
          )}
        </div>
        {availability.note === undefined ? null : (
          <p className="text-meta text-muted-foreground">{availability.note}</p>
        )}
      </div>
      {availability.openable ? (
        <Button
          type="button"
          variant={availability.action === undefined ? 'ghost' : 'outline'}
          size="sm"
          className="col-start-2 justify-self-start sm:col-start-auto"
          aria-label={`${availability.action ?? 'Open'} ${workspace.name}`}
          onClick={() => {
            onSelect(workspace);
          }}
        >
          {availability.action ?? 'Open'}
          {availability.action === undefined ? (
            <ArrowRightIcon aria-hidden="true" />
          ) : null}
        </Button>
      ) : null}
    </Row>
  );
}

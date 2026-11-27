import type { AccessibleWorkspace } from '@pertexo/contracts';
import { ArrowRightIcon } from 'lucide-react';
import { useId } from 'react';
import { Row } from '@/components/patterns/lists/row';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { WorkspaceMark } from '../shell/workspace-mark';
import { workspaceAvailability } from '../../model/workspace-availability';
import { ROLE_NAMES } from '../../model/role-words';

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
  const detailsId = useId();
  const noteId = `${detailsId}-note`;
  const Content = availability.openable ? 'button' : 'div';
  return (
    <Row className="block p-0" lift={availability.openable ? 'hover' : 'none'}>
      <Content
        {...(availability.openable
          ? {
              type: 'button',
              'aria-label': `${availability.action ?? 'Open'} ${workspace.name}`,
              'aria-describedby':
                availability.note === undefined
                  ? detailsId
                  : `${detailsId} ${noteId}`,
              onClick: () => {
                onSelect(workspace);
              },
            }
          : {})}
        className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-lg px-3.5 py-3 text-left outline-none focus-ring sm:grid-cols-[auto_minmax(0,1fr)_auto]"
      >
        <WorkspaceMark name={workspace.name} size="picker" />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-heading text-section font-semibold wrap-anywhere">
            {workspace.name}
          </span>
          <span
            id={detailsId}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground"
          >
            <span>
              {ROLE_NAMES[workspace.role]}
              {lastOpened ? ' · Last opened' : ''}
            </span>
            {workspace.status === 'active' ? null : (
              <StatusMark tone={availability.tone}>
                {availability.status}
              </StatusMark>
            )}
          </span>
          {availability.note === undefined ? null : (
            <span id={noteId} className="text-meta text-muted-foreground">
              {availability.note}
            </span>
          )}
        </span>
        {availability.openable ? (
          <span className="col-start-2 inline-flex items-center gap-1.5 text-sm font-medium sm:col-start-auto">
            {availability.action ?? 'Open'}
            {availability.action === undefined ? (
              <ArrowRightIcon aria-hidden="true" className="size-4" />
            ) : null}
          </span>
        ) : null}
      </Content>
    </Row>
  );
}

import type { WorkspaceInvitation } from '@pertexo/contracts/schemas/identity-workspace';
import { MoreHorizontalIcon, RotateCwIcon, XCircleIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import {
  describeInvitationDelivery,
  describeInvitationExpiry,
  describeInvitationStatus,
} from '../../model/invitation-words';
import { ROLE_NAMES } from '../../model/workspace-roles';

export type InvitationAction = 'resend' | 'revoke';

function InvitationRow({
  invitation,
  disabled,
  onAction,
}: Readonly<{
  invitation: WorkspaceInvitation;
  disabled: boolean;
  onAction: (invitation: WorkspaceInvitation, action: InvitationAction) => void;
}>) {
  const status = describeInvitationStatus(invitation.status);
  const delivery = describeInvitationDelivery(invitation.deliveryStatus);
  const expiry = describeInvitationExpiry(invitation);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1 border-t border-border py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_6rem_7rem_minmax(0,11rem)_2rem]">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold" title={invitation.email}>
          {invitation.email}
        </p>
        <p className="text-xs text-muted-foreground sm:hidden">
          {ROLE_NAMES[invitation.role]} · {status.label}
        </p>
      </div>
      <span className="text-[0.8rem] font-semibold max-sm:hidden">
        {ROLE_NAMES[invitation.role]}
      </span>
      <Status tone={status.tone} className="max-sm:hidden">
        {status.label}
      </Status>
      <span
        className={cn(
          'col-start-1 font-mono text-[0.72rem] sm:col-start-auto',
          delivery.problem ? 'text-warning' : 'text-subtle-foreground',
        )}
      >
        {delivery.label}
        {expiry === undefined ? null : ` · ${expiry}`}
      </span>
      {invitation.status === 'pending' ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            aria-label={`Actions for ${invitation.email}`}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
              'col-start-2 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto',
            )}
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  onAction(invitation, 'resend');
                }}
              >
                <RotateCwIcon aria-hidden="true" />
                Send a new link
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  onAction(invitation, 'revoke');
                }}
              >
                <XCircleIcon aria-hidden="true" />
                Revoke invitation
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span aria-hidden="true" className="max-sm:hidden" />
      )}
    </li>
  );
}

export function InvitationList({
  invitations,
  disabled,
  onAction,
}: Readonly<{
  invitations: readonly WorkspaceInvitation[];
  disabled: boolean;
  onAction: (invitation: WorkspaceInvitation, action: InvitationAction) => void;
}>) {
  return (
    <ul aria-label="Invitations" className="flex flex-col">
      {invitations.map((invitation) => (
        <InvitationRow
          key={invitation.id}
          invitation={invitation}
          disabled={disabled}
          onAction={onAction}
        />
      ))}
    </ul>
  );
}

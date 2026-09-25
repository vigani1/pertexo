import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import {
  CirclePauseIcon,
  CirclePlayIcon,
  CrownIcon,
  MoreHorizontalIcon,
  UserMinusIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Status, StatusGlyph } from '@/components/ui/status';
import { formatDate } from '@/lib/format-time';
import {
  ROLE_NAMES,
  type ManagedRole,
  type WorkspaceRole,
} from '../../model/workspace-roles';
import { PersonAvatar } from '../shell/workspace-mark';
import { RoleSelect } from './role-select';

/** What an actor may do to a member from the row's actions menu. */
export type MemberAction = 'transfer' | 'suspend' | 'reactivate' | 'remove';

export type MemberRowControl = Readonly<{
  roles: readonly ManagedRole[];
  canChange: (member: WorkspaceMember) => boolean;
  /** The menu actions for this member, in menu order. */
  actions: (member: WorkspaceMember) => readonly MemberAction[];
  /** The role shown while a change for this member awaits confirmation. */
  shownRole: (member: WorkspaceMember) => WorkspaceRole;
  disabled: boolean;
  feedback: (member: WorkspaceMember) => string | undefined;
  onPick: (member: WorkspaceMember, role: ManagedRole) => void;
  onAction: (member: WorkspaceMember, action: MemberAction) => void;
}>;

const ACTION_ITEMS: Readonly<
  Record<MemberAction, Readonly<{ label: string; icon: ReactNode }>>
> = {
  transfer: { label: 'Make owner…', icon: <CrownIcon aria-hidden="true" /> },
  suspend: { label: 'Suspend…', icon: <CirclePauseIcon aria-hidden="true" /> },
  reactivate: {
    label: 'Reactivate…',
    icon: <CirclePlayIcon aria-hidden="true" />,
  },
  remove: {
    label: 'Remove from workspace',
    icon: <UserMinusIcon aria-hidden="true" />,
  },
};

function MemberActions({
  member,
  control,
}: Readonly<{ member: WorkspaceMember; control: MemberRowControl }>) {
  const actions = control.actions(member);
  if (actions.length === 0)
    return <span aria-hidden="true" className="max-sm:hidden" />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={control.disabled}
        aria-label={`Actions for ${member.displayName}`}
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {actions.map((action) => (
            <MemberActionItem
              key={action}
              action={action}
              separated={action === 'remove' && actions.length > 1}
              onSelect={() => {
                control.onAction(member, action);
              }}
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MemberActionItem({
  action,
  separated,
  onSelect,
}: Readonly<{
  action: MemberAction;
  separated: boolean;
  onSelect: () => void;
}>) {
  const item = ACTION_ITEMS[action];
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        variant={action === 'remove' ? 'destructive' : 'default'}
        onClick={onSelect}
      >
        {item.icon}
        {item.label}
      </DropdownMenuItem>
    </>
  );
}

function MemberRow({
  member,
  isYou,
  control,
}: Readonly<{
  member: WorkspaceMember;
  isYou: boolean;
  control: MemberRowControl;
}>) {
  const feedback = control.feedback(member);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3.5 gap-y-1.5 border-t border-border py-3 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_8.5rem_6rem_6.5rem_2rem]">
      <PersonAvatar name={member.displayName} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-baseline gap-2">
          <span
            className="truncate text-sm font-semibold"
            title={member.displayName}
          >
            {member.displayName}
          </span>
          {isYou ? (
            <span className="font-mono text-[0.68rem] text-subtle-foreground">
              you
            </span>
          ) : null}
          {member.membershipStatus === 'suspended' ? (
            <span className="font-mono text-[0.68rem] text-warning sm:hidden">
              suspended
            </span>
          ) : null}
        </p>
        <p
          className="truncate text-xs text-muted-foreground"
          title={member.email}
        >
          {member.email}
        </p>
      </div>
      <div>
        {control.canChange(member) ? (
          <RoleSelect
            value={control.shownRole(member)}
            roles={control.roles}
            disabled={control.disabled}
            onChange={(role) => {
              control.onPick(member, role);
            }}
            triggerProps={{
              'aria-label': `Role for ${member.displayName}`,
              className: 'h-8 w-32 text-[0.8rem] font-semibold',
            }}
          />
        ) : (
          <span className="inline-flex h-8 items-center px-3 text-[0.8rem] font-semibold">
            {ROLE_NAMES[member.role]}
          </span>
        )}
      </div>
      <span className="max-sm:hidden">
        {member.membershipStatus === 'active' ? (
          <Status tone="success">Active</Status>
        ) : (
          <Status tone="attention">Suspended</Status>
        )}
      </span>
      <span className="font-mono text-[0.72rem] text-subtle-foreground max-sm:hidden">
        {formatDate(member.createdAt)}
      </span>
      <MemberActions member={member} control={control} />
      {feedback === undefined ? null : (
        <p
          role="alert"
          className="col-span-full flex items-start gap-2 pl-11.5 text-xs text-foreground"
        >
          <StatusGlyph tone="attention" className="text-warning" />
          {feedback}
        </p>
      )}
    </li>
  );
}

/** Everyone with access: who they are, their role and when they joined. */
export function MemberList({
  members,
  actorUserId,
  control,
}: Readonly<{
  members: readonly WorkspaceMember[];
  actorUserId: string;
  control: MemberRowControl;
}>) {
  return (
    <ul aria-label="Members" className="flex flex-col">
      {members.map((member) => (
        <MemberRow
          key={member.userId}
          member={member}
          isYou={member.userId === actorUserId}
          control={control}
        />
      ))}
    </ul>
  );
}

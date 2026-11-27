import type { WorkspaceMember } from '@pertexo/contracts';
import {
  CirclePauseIcon,
  CirclePlayIcon,
  CrownIcon,
  MoreHorizontalIcon,
  UserMinusIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Row, RowList } from '@/components/patterns/lists/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import {
  COLLAPSED_LIST_COUNT,
  ShowAll,
} from '@/components/patterns/lists/show-all';
import { groupMembers, type MemberGroup } from '../../model/member-groups';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { formatDate } from '@/lib/format/time';
import {
  ROLE_SUMMARIES,
  type ManagedRole,
  type WorkspaceRole,
} from '../../model/workspace-roles';
import { ROLE_NAMES } from '../../model/role-words';
import { RingMonogram } from '../shell/workspace-mark';
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
    <Row className="grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:grid-cols-[auto_minmax(0,12.5rem)_minmax(0,1fr)_auto_8rem_2.5rem]">
      <RingMonogram name={member.displayName} />
      <div className="flex min-w-0 flex-col sm:contents">
        <p className="flex min-w-0 items-baseline gap-2">
          <span
            className="truncate text-sm font-semibold"
            title={member.displayName}
          >
            {member.displayName}
          </span>
          {isYou ? (
            <span className="font-mono text-caption text-subtle-foreground">
              you
            </span>
          ) : null}
          {member.membershipStatus === 'suspended' ? (
            <StatusMark tone="attention">Suspended</StatusMark>
          ) : null}
        </p>
        <p
          className="truncate font-mono text-caption text-subtle-foreground"
          title={member.email}
        >
          {member.email}
        </p>
      </div>
      <span className="font-mono text-caption whitespace-nowrap text-subtle-foreground max-sm:hidden">
        joined {formatDate(member.createdAt)}
      </span>
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
              className: 'h-8 w-30 text-label font-semibold',
            }}
          />
        ) : (
          <span className="inline-flex h-8 items-center px-3 text-label text-muted-foreground">
            {ROLE_NAMES[member.role]}
          </span>
        )}
      </div>
      <MemberActions member={member} control={control} />
      {member.directorySource === undefined ? null : (
        <p className="col-span-full pl-11.5 text-xs text-muted-foreground">
          Directory-managed. Ask the organization’s control workspace owner to
          change access.
        </p>
      )}
      {feedback === undefined ? null : (
        <p
          role="alert"
          className="col-span-full flex items-start gap-2 pl-11.5 text-xs text-foreground"
        >
          <StatusMark
            display="mark"
            tone="attention"
            className="text-warning"
          />
          {feedback}
        </p>
      )}
    </Row>
  );
}

/** One role's members: five, then “Show all N”. */
function MemberGroupSection({
  group,
  actorUserId,
  control,
}: Readonly<{
  group: MemberGroup;
  actorUserId: string;
  control: MemberRowControl;
}>) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const shown = expanded
    ? group.members
    : group.members.slice(0, COLLAPSED_LIST_COUNT);
  return (
    <section aria-labelledby={`${listId}-heading`} className="flex flex-col">
      <RuleHeading id={`${listId}-heading`} count={group.members.length}>
        {ROLE_GROUP_NAMES[group.role]}
      </RuleHeading>
      <p className="mt-1 text-meta text-subtle-foreground">
        {ROLE_SUMMARIES[group.role]}
      </p>
      <RowList
        id={listId}
        aria-label={ROLE_GROUP_NAMES[group.role]}
        className="mt-2"
      >
        {shown.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            isYou={member.userId === actorUserId}
            control={control}
          />
        ))}
      </RowList>
      <div className="mt-1">
        <ShowAll
          count={group.members.length}
          controls={listId}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
      </div>
    </section>
  );
}

const ROLE_GROUP_NAMES: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'Owner',
  admin: 'Admins',
  builder: 'Builders',
  operator: 'Operators',
  viewer: 'Viewers',
};

/** Everyone with access, grouped by role: who they are and when they joined. */
export function MemberList({
  members,
  actorUserId,
  control,
  search,
}: Readonly<{
  members: readonly WorkspaceMember[];
  actorUserId: string;
  control: MemberRowControl;
  search: string;
}>) {
  const groups = groupMembers(members, search);
  if (groups.length === 0)
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No member matches “{search.trim()}”.
      </p>
    );
  return (
    <div aria-label="Members" role="group" className="flex flex-col gap-8">
      {groups.map((group) => (
        <MemberGroupSection
          key={group.role}
          group={group}
          actorUserId={actorUserId}
          control={control}
        />
      ))}
    </div>
  );
}

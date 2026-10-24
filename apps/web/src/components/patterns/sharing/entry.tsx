import type { ReactNode } from 'react';
import { ShieldCheckIcon, UsersRoundIcon } from 'lucide-react';
import { formatInitials } from '@/lib/format/initials';
import { cn } from '@/lib/utils';

/** A person's initials, or a group mark, in the same ringed disc as presence. */
function SharingAvatar({
  label,
  kind,
}: Readonly<{ label: string; kind: 'member' | 'group' | 'administrators' }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-full border border-background font-mono text-[0.65rem] ring-1',
        kind === 'member'
          ? 'bg-raised text-foreground ring-border-strong'
          : 'bg-primary/10 text-primary ring-primary/30',
      )}
    >
      <SharingAvatarMark kind={kind} label={label} />
    </span>
  );
}

/** One row of who has access: who they are on the left, their controls on the right. */
export function SharingEntry({
  label,
  detail,
  kind,
  children,
}: Readonly<{
  label: string;
  detail?: string | undefined;
  kind: 'member' | 'group' | 'administrators';
  children?: ReactNode;
}>) {
  return (
    <li className="flex min-w-0 items-center gap-3 py-2">
      <SharingAvatar label={label} kind={kind} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{label}</span>
        {detail === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      {children === undefined ? null : (
        <span className="flex shrink-0 items-center gap-1">{children}</span>
      )}
    </li>
  );
}

/** Owners and admins can't be removed, so they're stated, not listed as choices. */
export function SharingAdministratorsEntry() {
  return (
    <SharingEntry
      kind="administrators"
      label="Workspace owners and admins"
      detail="Always have access"
    />
  );
}

function SharingAvatarMark({
  kind,
  label,
}: Readonly<{ kind: 'member' | 'group' | 'administrators'; label: string }>) {
  return kind === 'member' ? (
    formatInitials(label)
  ) : kind === 'group' ? (
    <UsersRoundIcon className="size-3.5" />
  ) : (
    <ShieldCheckIcon className="size-3.5" />
  );
}

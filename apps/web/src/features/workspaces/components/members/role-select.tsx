import type { ComponentProps, ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ROLE_NAMES,
  ROLE_SUMMARIES,
  type ManagedRole,
  type WorkspaceRole,
} from '../../model/workspace-roles';

type RoleSelectProps = Readonly<{
  value: WorkspaceRole;
  roles: readonly ManagedRole[];
  disabled?: boolean;
  onChange: (role: ManagedRole) => void;
  triggerProps?: Omit<ComponentProps<typeof SelectTrigger>, 'children'>;
}>;

const ROLE_ITEMS = Object.entries(ROLE_NAMES).map(([role, label]) => ({
  value: role,
  label,
}));

/** The shared picker: its value, trigger and the options each variant draws. */
function RoleSelectFrame({
  value,
  roles,
  disabled,
  onChange,
  triggerProps,
  contentClassName,
  children,
}: RoleSelectProps &
  Readonly<{ contentClassName?: string; children: ReactNode }>) {
  return (
    <Select
      value={value}
      {...(disabled === undefined ? {} : { disabled })}
      items={ROLE_ITEMS}
      onValueChange={(next: string | null) => {
        const role = roles.find((candidate) => candidate === next);
        if (role !== undefined) onChange(role);
      }}
    >
      <SelectTrigger {...triggerProps}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={contentClassName}>{children}</SelectContent>
    </Select>
  );
}

/** Picks a workspace role by name, e.g. inline on a member row. */
export function RoleSelect(props: RoleSelectProps) {
  return (
    <RoleSelectFrame {...props}>
      {props.roles.map((role) => (
        <SelectItem key={role} value={role}>
          {ROLE_NAMES[role]}
        </SelectItem>
      ))}
    </RoleSelectFrame>
  );
}

/**
 * Picks a role with each option's one-line description, for people deciding
 * what to give someone, e.g. when inviting.
 */
export function RoleSelectWithSummaries(props: RoleSelectProps) {
  return (
    <RoleSelectFrame {...props} contentClassName="min-w-72">
      {props.roles.map((role) => (
        <SelectItem key={role} value={role}>
          <span className="flex flex-col">
            <span>{ROLE_NAMES[role]}</span>
            <span className="text-xs text-muted-foreground">
              {ROLE_SUMMARIES[role]}
            </span>
          </span>
        </SelectItem>
      ))}
    </RoleSelectFrame>
  );
}

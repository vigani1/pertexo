import type { ComponentProps } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type ManagedRole,
  type WorkspaceRole,
} from '../../model/workspace-roles';
import { ROLE_NAMES } from '../../model/role-words';

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

/** Picks a workspace role by name, e.g. inline on a member row. */
export function RoleSelect({
  value,
  roles,
  disabled,
  onChange,
  triggerProps,
}: RoleSelectProps) {
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
      <SelectContent>
        {roles.map((role) => (
          <SelectItem key={role} value={role}>
            {ROLE_NAMES[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

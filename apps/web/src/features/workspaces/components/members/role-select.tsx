import type { ComponentProps } from 'react';
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

/**
 * Picks a workspace role by name. `withSummaries` adds each role's one-line
 * description to the options, for people deciding what to give someone.
 */
export function RoleSelect({
  value,
  roles,
  disabled,
  withSummaries = false,
  onChange,
  triggerProps,
}: Readonly<{
  value: WorkspaceRole;
  roles: readonly ManagedRole[];
  disabled?: boolean;
  withSummaries?: boolean;
  onChange: (role: ManagedRole) => void;
  triggerProps?: Omit<ComponentProps<typeof SelectTrigger>, 'children'>;
}>) {
  return (
    <Select
      value={value}
      {...(disabled === undefined ? {} : { disabled })}
      items={Object.entries(ROLE_NAMES).map(([role, label]) => ({
        value: role,
        label,
      }))}
      onValueChange={(next: string | null) => {
        const role = roles.find((candidate) => candidate === next);
        if (role !== undefined) onChange(role);
      }}
    >
      <SelectTrigger {...triggerProps}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={withSummaries ? 'min-w-72' : undefined}>
        {roles.map((role) => (
          <SelectItem key={role} value={role}>
            {withSummaries ? (
              <span className="flex flex-col">
                <span>{ROLE_NAMES[role]}</span>
                <span className="text-xs text-muted-foreground">
                  {ROLE_SUMMARIES[role]}
                </span>
              </span>
            ) : (
              ROLE_NAMES[role]
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

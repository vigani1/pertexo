import { QueryView } from '@/components/patterns/states/query-view';
import type { DelegatedRole } from '@pertexo/workflow-model';
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  delegatedWorkspaceRoleSchema,
  type FederationSettings,
} from '@pertexo/contracts';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';
import { SettingsSection } from '@/components/patterns/settings/section';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
type Organization = NonNullable<FederationSettings['organization']>;
export function OrganizationWorkspaces({
  scope,
  organization,
  editable,
}: Readonly<{
  scope: FederationScope;
  organization: Organization;
  editable: boolean;
}>) {
  const id = useId(),
    choices = useQuery({
      ...accessibleWorkspacesQueryOptions(scope.apiClient, scope.userId),
      enabled: editable,
    });
  const [target, setTarget] = useState<string | null>(null),
    [role, setRole] = useState<DelegatedRole>('viewer');
  const validation = useFieldValidation<'workspace'>(),
    command = useFederationCommand(scope, () => {
      setTarget(null);
      validation.reset();
    });
  const locked = !editable || command.pending || command.uncertain;
  const available =
    choices.data?.filter(
      (workspace) =>
        workspace.role === 'owner' && workspace.status === 'active',
    ) ?? [];
  return (
    <SettingsSection
      title="Linked workspaces"
      description="The control workspace owner manages organization sign-in. Linking another workspace delegates its directory membership policy here; you must currently own both workspaces."
    >
      <ul className="divide-y divide-border">
        {organization.workspaces.map((workspace) => (
          <li
            key={workspace.workspaceId}
            className="flex flex-wrap justify-between gap-2 py-2 text-sm"
          >
            <span>
              {workspace.name}
              {workspace.workspaceId === organization.controlWorkspaceId
                ? ' · Control workspace'
                : ''}
            </span>
            <span className="text-muted-foreground">
              New members: {workspace.defaultRole}
            </span>
          </li>
        ))}
      </ul>
      {editable ? (
        <form
          noValidate
          className="max-w-xl space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !validation.submit({
                workspace: target === null ? 'Choose a workspace.' : undefined,
              }) ||
              target === null ||
              locked
            )
              return;
            void command.send({
              kind: 'linkWorkspace',
              input: {
                workspaceId: target,
                defaultRole: role,
                expectedRevision: organization.revision,
              },
            });
          }}
        >
          <LabelledField
            id={id}
            label="Workspace"
            error={validation.error('workspace')}
            description="Choose a linked workspace to change its new-member default, or another workspace to link it."
          >
            {(control) => (
              <Select
                items={available.map((workspace) => ({
                  value: workspace.id,
                  label: workspace.name,
                }))}
                value={target}
                onValueChange={(value) => {
                  setTarget(value);
                  validation.change(
                    'workspace',
                    value === null ? 'Choose a workspace.' : undefined,
                  );
                }}
                disabled={locked}
              >
                <SelectTrigger
                  {...control}
                  ref={validation.register('workspace')}
                >
                  <SelectValue
                    placeholder={
                      choices.isPending
                        ? 'Loading workspaces…'
                        : 'Choose workspace'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {available.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </LabelledField>
          <LabelledField id={`${id}-role`} label="Default role for new members">
            {(control) => (
              <Select
                value={role}
                onValueChange={(value) => {
                  const parsed = delegatedWorkspaceRoleSchema.safeParse(value);
                  if (parsed.success) setRole(parsed.data);
                }}
                disabled={locked}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {delegatedWorkspaceRoleSchema.options.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value.charAt(0).toUpperCase() + value.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </LabelledField>
          <ProgressButton
            type="submit"
            variant="outline"
            pending={command.pending}
            pendingLabel="Saving…"
            disabled={locked || available.length === 0}
          >
            Save linked workspace
          </ProgressButton>
          <QueryView
            query={choices}
            resource="Workspace choices"
            loading={null}
          />
          <CommandFeedback command={command} />
        </form>
      ) : null}
    </SettingsSection>
  );
}

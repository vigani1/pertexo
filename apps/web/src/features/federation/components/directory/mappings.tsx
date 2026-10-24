import { MappingRows } from './mapping-rows';
import type { DelegatedRole } from '@pertexo/workflow-model';
import { Status } from '@/components/ui/status';
import { useId, useState } from 'react';
import {
  delegatedWorkspaceRoleSchema,
  DIRECTORY_LIMITS,
  type DirectorySettings,
  type DirectoryMappings,
  type FederationSettings,
} from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useDirectoryCommand } from '../../data/directory.mutations';
import type { FederationScope } from '../../data/settings.api';
import { CommandFeedback } from '../command-feedback';

type Organization = NonNullable<FederationSettings['organization']>;
type DirectoryMappingsEditorProps = Readonly<{
  scope: FederationScope;
  settings: DirectorySettings;
  organization: Organization;
  editable: boolean;
}>;

export function DirectoryMappingsEditor({
  scope,
  settings,
  organization,
  editable,
}: DirectoryMappingsEditorProps) {
  const id = useId();
  const [edit, setEdit] = useState<{
      mappings: DirectoryMappings['mappings'];
      revision: number;
    }>(),
    [selectedWorkspaceId, setWorkspaceId] = useState<string>(),
    [groupId, setGroupId] = useState<string | null>(null),
    [role, setRole] = useState<DelegatedRole>('viewer'),
    [saved, setSaved] = useState(false);
  const command = useDirectoryCommand(scope, () => {
    setSaved(true);
    setEdit(undefined);
  });
  const draft = edit?.mappings ?? settings.mappings;
  const revision = edit?.revision ?? settings.revision;
  const workspaceId = selectedWorkspaceId ?? scope.workspaceId;
  const locked = !editable || command.pending || command.uncertain;
  const rows = draft
    .filter((mapping) => mapping.workspaceId === workspaceId)
    .sort((left, right) => left.priority - right.priority);
  const choices = settings.groups.filter(
    (group) => !rows.some((mapping) => mapping.groupId === group.id),
  );
  function changeRows(next: DirectoryMappings['mappings']) {
    setSaved(false);
    setEdit({
      revision,
      mappings: [
        ...draft.filter((mapping) => mapping.workspaceId !== workspaceId),
        ...next.map((mapping, priority) => ({ ...mapping, priority })),
      ],
    });
  }
  function move(index: number, direction: -1 | 1) {
    const next = [...rows],
      target = next[index + direction],
      current = next[index];
    if (target === undefined || current === undefined) return;
    next[index] = target;
    next[index + direction] = current;
    changeRows(next);
  }
  return (
    <SettingsSection
      title="Group roles"
      description="The first matching group wins. A person outside these groups receives the linked workspace’s default role. Builder and operator are separate roles; they are not ranked."
    >
      <MappingWorkspaceChoice
        id={id}
        workspaceId={workspaceId}
        organization={organization}
        disabled={command.pending || command.uncertain}
        onChange={(value) => {
          setWorkspaceId(value);
          setGroupId(null);
        }}
      />
      {revision === settings.revision ? null : (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => {
                setEdit(undefined);
                setSaved(false);
                command.reset();
              }}
            >
              Load current mappings
            </Button>
          }
        >
          Directory settings changed. Your edits are kept; load current mappings
          before replacing them.
        </Notice>
      )}
      <MappingRows
        rows={rows}
        groups={settings.groups}
        editable={editable}
        locked={locked}
        onChange={changeRows}
        onMove={move}
      />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No group mappings for this workspace. Its default role is{' '}
          {organization.workspaces.find(
            (workspace) => workspace.workspaceId === workspaceId,
          )?.defaultRole ?? 'viewer'}
          .
        </p>
      ) : null}
      {editable ? (
        <AddGroupMapping
          id={id}
          choices={choices}
          locked={locked}
          selection={{ groupId, role }}
          full={rows.length >= DIRECTORY_LIMITS.mappingsPerWorkspace}
          onChange={(next) => {
            setGroupId(next.groupId);
            setRole(next.role);
          }}
          onAdd={() => {
            if (
              groupId === null ||
              locked ||
              rows.length >= DIRECTORY_LIMITS.mappingsPerWorkspace
            )
              return;
            changeRows([
              ...rows,
              { workspaceId, groupId, role, priority: rows.length },
            ]);
            setGroupId(null);
          }}
        />
      ) : null}
      <CommandFeedback command={command} />
      {saved ? <Status tone="success">Group mappings saved.</Status> : null}
      {editable ? (
        <ProgressButton
          type="button"
          variant="primary"
          pending={command.pending}
          pendingLabel="Saving mappings…"
          disabled={locked || revision !== settings.revision}
          onClick={() =>
            void command.send({
              kind: 'mappings',
              input: { mappings: draft, expectedRevision: revision },
            })
          }
        >
          Save group mappings
        </ProgressButton>
      ) : null}
    </SettingsSection>
  );
}

type MappingSelection = Readonly<{
  groupId: string | null;
  role: DelegatedRole;
}>;
function AddGroupMapping({
  id,
  choices,
  locked,
  selection,
  full,
  onChange,
  onAdd,
}: Readonly<{
  id: string;
  choices: DirectorySettings['groups'];
  locked: boolean;
  selection: MappingSelection;
  full: boolean;
  onChange: (selection: MappingSelection) => void;
  onAdd: () => void;
}>) {
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onAdd();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <LabelledField id={`${id}-group`} label="Directory group">
          {(control) => (
            <Select
              value={selection.groupId}
              items={choices.map((group) => ({
                value: group.id,
                label: group.displayName,
              }))}
              onValueChange={(groupId) => {
                onChange({ ...selection, groupId });
              }}
              disabled={locked || choices.length === 0}
            >
              <SelectTrigger {...control}>
                <SelectValue
                  placeholder={
                    choices.length === 0
                      ? 'No unmapped groups'
                      : 'Choose a group'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {choices.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </LabelledField>
        <LabelledField id={`${id}-role`} label="Role">
          {(control) => (
            <Select
              value={selection.role}
              onValueChange={(value) => {
                const parsed = delegatedWorkspaceRoleSchema.safeParse(value);
                if (parsed.success)
                  onChange({ ...selection, role: parsed.data });
              }}
              disabled={locked}
            >
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {delegatedWorkspaceRoleSchema.options.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </LabelledField>
      </div>
      <Button
        type="submit"
        variant="outline"
        disabled={locked || selection.groupId === null || full}
      >
        Add group mapping
      </Button>
      <p className="text-xs text-muted-foreground">
        Up to {DIRECTORY_LIMITS.mappingsPerWorkspace} mappings per workspace.
        New groups appear after your identity provider provisions them.
      </p>
    </form>
  );
}

function MappingWorkspaceChoice({
  id,
  workspaceId,
  organization,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  workspaceId: string;
  organization: Organization;
  disabled: boolean;
  onChange: (workspaceId: string) => void;
}>) {
  return (
    <LabelledField id={`${id}-workspace`} label="Workspace">
      {(control) => (
        <Select
          value={workspaceId}
          items={organization.workspaces.map((workspace) => ({
            value: workspace.workspaceId,
            label: workspace.name,
          }))}
          onValueChange={(value) => {
            if (value !== null) onChange(value);
          }}
          disabled={disabled}
        >
          <SelectTrigger {...control}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {organization.workspaces.map((workspace) => (
              <SelectItem
                key={workspace.workspaceId}
                value={workspace.workspaceId}
              >
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </LabelledField>
  );
}

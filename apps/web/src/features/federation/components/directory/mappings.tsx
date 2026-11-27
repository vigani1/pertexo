import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';
import { MappingRows } from './mapping-rows';
import type { DelegatedRole } from '@pertexo/policy';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { useId, useState } from 'react';
import {
  delegatedWorkspaceRoleSchema,
  type DirectorySettings,
  type DirectoryMappings,
  type FederationSettings,
} from '@pertexo/contracts';
import { SettingRow } from '@/components/patterns/settings/row';
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
import { Notice } from '@/components/patterns/notices/inline-notice';
import { useDirectoryCommand } from '../../data/directory.mutations';
import type { FederationScope } from '../../data/federation-settings.api';
import { CommandFeedback } from '../command-feedback';

type Organization = NonNullable<FederationSettings['organization']>;
type DirectoryMappingsEditorProps = Readonly<{
  scope: FederationScope;
  settings: DirectorySettings;
  organization: Organization;
  editable: boolean;
}>;

function orderedMappings(
  mappings: DirectoryMappings['mappings'],
  workspaceId: string,
) {
  return mappings
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => left.priority - right.priority);
}

const GROUP_ORDER =
  'The first matching group wins. A person outside these groups receives the linked workspace’s default role. Builder and operator have different permissions.';

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
  const rows = orderedMappings(draft, workspaceId);
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
  function chooseWorkspace(value: string) {
    setWorkspaceId(value);
    setGroupId(null);
  }
  return (
    <SettingRow layout="section" title="Group roles" description={GROUP_ORDER}>
      <MappingWorkspaceChoice
        id={id}
        workspaceId={workspaceId}
        organization={organization}
        disabled={command.pending || command.uncertain}
        onChange={chooseWorkspace}
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
      {saved && <StatusMark tone="success">Group mappings saved</StatusMark>}
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
    </SettingRow>
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

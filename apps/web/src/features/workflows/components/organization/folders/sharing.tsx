import { useId, useState } from 'react';
import type { FolderPrincipal } from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { describeReadError } from '@/lib/api/error-copy';
import { SharingModeField } from '@/components/patterns/sharing/mode-field';
import { SharingPrincipalPicker } from '@/components/patterns/sharing/principal-picker';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { useFolderSharingEditor } from '../../../hooks/use-folder-sharing';
type Editor = ReturnType<typeof useFolderSharingEditor>;
const principalId = (principal: FolderPrincipal) =>
  principal.kind === 'member' ? principal.userId : principal.groupId;
export function FolderSharingPanel({
  scope,
  name,
  editor,
}: Readonly<{ scope: WorkspaceApiScope; name: string; editor: Editor }>) {
  const [kind, setKind] = useState<'member' | 'group'>('member');
  const id = useId();
  const snapshot = editor.snapshot;
  if (!snapshot) return <SharingReadState editor={editor} />;
  return (
    <section className="flex flex-col gap-4" aria-label={`Sharing for ${name}`}>
      <h3 className="font-heading">Who can access {name}?</h3>
      <p className="text-sm text-muted-foreground">
        Owners and admins keep access. Workspace roles remain the ceiling.
        Restrictions on parent folders still apply.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void editor.submit();
        }}
      >
        <FieldGroup>
          <SharingModeField
            label="Access"
            restrictedLabel="Selected members and groups"
            value={snapshot.mode}
            disabled={editor.locked}
            onChange={(mode) => {
              editor.update((value) => ({ ...value, mode }));
            }}
          />
          {snapshot.mode === 'restricted' ? (
            <>
              <FolderGrants editor={editor} />
              <LabelledField id={id} label="Add access for">
                {(control) => (
                  <Select
                    items={[
                      { value: 'member', label: 'Member' },
                      { value: 'group', label: 'Directory group' },
                    ]}
                    value={kind}
                    disabled={editor.locked}
                    onValueChange={(value) => {
                      if (value === 'member' || value === 'group')
                        setKind(value);
                    }}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="group">Directory group</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              </LabelledField>
              <SharingPrincipalPicker
                apiClient={scope.apiClient}
                userId={scope.userId}
                workspaceId={scope.workspaceId}
                kind={kind}
                selected={snapshot.grants.map(principalId)}
                disabled={editor.locked || snapshot.grants.length >= 100}
                onAdd={(principal) => {
                  const identifier =
                    principal.kind === 'member'
                      ? principal.userId
                      : principal.groupId;
                  if (
                    snapshot.grants.length >= 100 ||
                    snapshot.grants.some(
                      (grant) => principalId(grant) === identifier,
                    )
                  )
                    return;
                  const grant: FolderPrincipal =
                    principal.kind === 'member'
                      ? {
                          kind: 'member',
                          userId: principal.userId,
                          access: 'viewer',
                        }
                      : {
                          kind: 'group',
                          groupId: principal.groupId,
                          organizationId: principal.organizationId,
                          access: 'viewer',
                        };
                  editor.update((value) => ({
                    ...value,
                    grants: [...value.grants, grant],
                    labels: { ...value.labels, [identifier]: principal.label },
                  }));
                }}
              />
              <p className="text-xs text-subtle-foreground">
                {snapshot.grants.length} of 100 sharing entries. Viewer permits
                reading; Editor also permits authoring within the workspace
                role.
              </p>
            </>
          ) : null}
          {editor.stale ? (
            <Notice tone="warning">
              Sharing changed while this form was open. Your edits are kept.
              Reload before saving.
            </Notice>
          ) : null}
          {editor.command.error ? (
            <Notice tone="warning">{editor.command.error}</Notice>
          ) : null}
          {editor.reader.isError ? <SharingReadState editor={editor} /> : null}
          <div className="flex flex-wrap gap-2">
            {editor.command.uncertain ? (
              <Button
                type="button"
                variant="outline"
                disabled={editor.command.pending || editor.command.expired}
                onClick={editor.command.retry}
              >
                Retry exact sharing change
              </Button>
            ) : (
              <ProgressButton
                type="submit"
                pending={editor.command.pending}
                pendingLabel="Saving…"
                disabled={
                  editor.locked || editor.stale || !editor.reader.isSuccess
                }
              >
                Save sharing
              </ProgressButton>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={editor.locked}
              onClick={() => {
                void editor.reload();
              }}
            >
              Discard edits and reload sharing
            </Button>
          </div>
        </FieldGroup>
      </form>
    </section>
  );
}
function FolderGrants({ editor }: Readonly<{ editor: Editor }>) {
  const id = useId();
  const snapshot = editor.snapshot;
  if (!snapshot || snapshot.grants.length === 0)
    return <Notice>Only owners and admins can access this folder.</Notice>;
  const accesses = [
    { value: 'viewer', label: 'Viewer' },
    { value: 'editor', label: 'Editor' },
  ];
  return (
    <ul className="flex flex-col gap-3" aria-label="Folder grants">
      {snapshot.grants.map((grant) => {
        const identifier = principalId(grant),
          label =
            snapshot.labels?.[identifier] ??
            `${grant.kind === 'member' ? 'Member' : 'Group'} ${identifier.slice(0, 8)}`;
        return (
          <li
            key={identifier}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
          >
            <span className="col-span-2 min-w-0 wrap-anywhere">{label}</span>
            <div className="min-w-0 max-w-52">
              <LabelledField
                id={`${id}-${identifier}`}
                label={`Access for ${label}`}
              >
                {(control) => (
                  <Select
                    items={accesses}
                    value={grant.access}
                    disabled={editor.locked}
                    onValueChange={(value) => {
                      if (value === 'viewer' || value === 'editor')
                        editor.update((snapshot) => ({
                          ...snapshot,
                          grants: snapshot.grants.map((item) =>
                            principalId(item) === identifier
                              ? { ...item, access: value }
                              : item,
                          ),
                        }));
                    }}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {accesses.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              </LabelledField>
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={editor.locked}
              aria-label={`Remove ${label}`}
              onClick={() => {
                editor.update((value) => ({
                  ...value,
                  grants: value.grants.filter(
                    (item) => principalId(item) !== identifier,
                  ),
                }));
              }}
            >
              Remove
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
function SharingReadState({ editor }: Readonly<{ editor: Editor }>) {
  if (editor.reader.isError)
    return (
      <Notice tone="warning">
        {describeReadError(editor.reader.error, 'Folder sharing')}{' '}
        <Button
          type="button"
          variant="outline"
          disabled={editor.reader.isFetching}
          onClick={() => {
            void editor.reader.refetch();
          }}
        >
          Retry
        </Button>
      </Notice>
    );
  return <p role="status">Loading folder sharing…</p>;
}

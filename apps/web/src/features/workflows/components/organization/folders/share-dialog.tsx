import { XIcon } from 'lucide-react';
import type { FolderPrincipal, WorkflowFolder } from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { describeReadError } from '@/lib/api/error-copy';
import { ROLE_NAMES } from '@/features/workspaces/roles.public';
import { SharingModeChoice } from '@/components/patterns/sharing/mode-choice';
import {
  SharingAdministratorsEntry,
  SharingEntry,
} from '@/components/patterns/sharing/entry';
import { SharingPrincipalPicker } from '@/components/patterns/sharing/principal-picker';
import { principalIdentifier } from '@/lib/resource-sharing/principal';
import { ActionDialog } from '@/components/patterns/actions/action-dialog';
import { Button } from '@/components/ui/button';
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
import { useNotifications } from '@/components/ui/use-notifications';
import { useFolderSharingEditor } from '../../../hooks/use-folder-sharing';
import { folderTrail } from '../../../model/organization/folder-navigation';

type Editor = ReturnType<typeof useFolderSharingEditor>;
const MAX_ENTRIES = 100;
const ACCESS_CHOICES = [
  { value: 'viewer', label: 'Can view' },
  { value: 'editor', label: 'Can edit' },
] as const;
const grantId = (grant: FolderPrincipal) =>
  grant.kind === 'member' ? grant.userId : grant.groupId;

export function FolderShareDialog({
  scope,
  folder,
  folders,
  onClose,
}: Readonly<{
  scope: WorkspaceApiScope;
  folder: WorkflowFolder;
  folders: readonly WorkflowFolder[];
  onClose: () => void;
}>) {
  const notifications = useNotifications();
  const editor = useFolderSharingEditor(scope, folder.id, () => {
    notifications.success({ title: `Sharing saved for ${folder.name}` });
    onClose();
  });
  const snapshot = editor.snapshot;
  // A restricted folder above this one narrows it further; say which.
  const narrowedBy = folderTrail(folders, folder.parentId ?? undefined).filter(
    (ancestor) => ancestor.accessMode === 'restricted',
  );
  return (
    <ActionDialog
      className="max-w-xl"
      title={`Share ${folder.name}`}
      description="Choose who can see and run the workflows in this folder."
      locked={editor.closeLocked}
      onClose={() => {
        editor.discard();
        onClose();
      }}
      footer={<FolderShareFooter editor={editor} onClose={onClose} />}
    >
      {snapshot === undefined ? (
        <SharingReadState editor={editor} />
      ) : (
        <>
          <SharingModeChoice
            legend="Who has access"
            value={snapshot.mode}
            disabled={editor.locked}
            everyone={{
              label: 'Everyone in this workspace',
              hint: 'Each person keeps the access their role gives them.',
            }}
            restricted={{
              label: 'Only people you choose',
              hint: 'Owners and admins always keep access.',
            }}
            onChange={(mode) => {
              editor.update((value) => ({ ...value, mode }));
            }}
          />
          {narrowedBy.length === 0 ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              People also need access to{' '}
              {narrowedBy.map((ancestor, index) => (
                <span key={ancestor.id}>
                  {index === 0 ? '' : ' and '}“{ancestor.name}”
                </span>
              ))}
              , which {narrowedBy.length === 1 ? 'is' : 'are'} above this
              folder.
            </p>
          )}
          {snapshot.mode === 'restricted' ? (
            <FolderAudience scope={scope} editor={editor} />
          ) : null}
          <SaveState editor={editor} />
        </>
      )}
    </ActionDialog>
  );
}

function FolderAudience({
  scope,
  editor,
}: Readonly<{ scope: WorkspaceApiScope; editor: Editor }>) {
  const snapshot = editor.snapshot;
  if (snapshot === undefined) return null;
  const full = snapshot.grants.length >= MAX_ENTRIES;
  return (
    <>
      <section aria-label="People with access" className="flex flex-col">
        <ul className="flex flex-col divide-y divide-border">
          <SharingAdministratorsEntry />
          {snapshot.grants.map((grant) => {
            const identifier = grantId(grant);
            const label =
              snapshot.labels?.[identifier] ??
              (grant.kind === 'member' ? 'Former member' : 'Directory group');
            return (
              <SharingEntry
                key={identifier}
                kind={grant.kind}
                label={label}
                detail={grant.kind === 'group' ? 'Directory group' : undefined}
              >
                <Select
                  items={ACCESS_CHOICES}
                  value={grant.access}
                  disabled={editor.locked}
                  onValueChange={(access) => {
                    if (access === 'viewer' || access === 'editor')
                      editor.update((value) => ({
                        ...value,
                        grants: value.grants.map((item) =>
                          grantId(item) === identifier
                            ? { ...item, access }
                            : item,
                        ),
                      }));
                  }}
                >
                  <SelectTrigger
                    aria-label={`Access for ${label}`}
                    className="h-8 w-auto min-w-28 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {ACCESS_CHOICES.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={editor.locked}
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    editor.update((value) => ({
                      ...value,
                      grants: value.grants.filter(
                        (item) => grantId(item) !== identifier,
                      ),
                    }));
                  }}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </SharingEntry>
            );
          })}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">
          Can view lets people open and run workflows. Can edit also lets them
          change and publish, when their role allows it.
          {snapshot.grants.length >= MAX_ENTRIES - 10
            ? ` ${String(snapshot.grants.length)} of ${String(MAX_ENTRIES)} people and groups.`
            : ''}
        </p>
      </section>
      <SharingPrincipalPicker
        kinds={['member', 'group']}
        roleNames={ROLE_NAMES}
        selected={snapshot.grants.map(grantId)}
        full={full}
        disabled={editor.locked}
        onAdd={(principal) => {
          const identifier = principalIdentifier(principal);
          editor.update((value) =>
            value.grants.length >= MAX_ENTRIES ||
            value.grants.some((grant) => grantId(grant) === identifier)
              ? value
              : {
                  ...value,
                  grants: [
                    ...value.grants,
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
                        },
                  ],
                  labels: { ...value.labels, [identifier]: principal.label },
                },
          );
        }}
        scope={{
          apiClient: scope.apiClient,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
        }}
      />
    </>
  );
}

function SaveState({ editor }: Readonly<{ editor: Editor }>) {
  return (
    <>
      {editor.stale ? (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={editor.locked}
              onClick={() => {
                void editor.reload();
              }}
            >
              Reload
            </Button>
          }
        >
          Someone changed who can access this folder while you were editing.
          Reload to see the latest, then make your change again.
        </Notice>
      ) : null}
      {editor.reader.isError && !editor.stale ? (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={editor.locked || editor.reader.isFetching}
              onClick={() => {
                void editor.reload();
              }}
            >
              Reload
            </Button>
          }
        >
          Couldn’t check the latest sharing. Your changes are kept; reload
          before saving.
        </Notice>
      ) : null}
      {editor.command.error === undefined ? null : (
        <Notice tone="warning">{editor.command.error}</Notice>
      )}
    </>
  );
}

function FolderShareFooter({
  editor,
  onClose,
}: Readonly<{ editor: Editor; onClose: () => void }>) {
  const sharingSaveBlocked = !editor.canSaveChanges;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={editor.closeLocked}
        onClick={() => {
          editor.discard();
          onClose();
        }}
      >
        Cancel
      </Button>
      {editor.command.uncertain ? (
        <ProgressButton
          type="button"
          pending={editor.command.pending}
          pendingLabel="Trying again…"
          disabled={editor.command.expired}
          onClick={editor.command.retry}
        >
          Try again
        </ProgressButton>
      ) : (
        <ProgressButton
          type="button"
          variant="primary"
          pending={editor.command.pending}
          pendingLabel="Saving…"
          disabled={sharingSaveBlocked}
          onClick={() => {
            void editor.submit();
          }}
        >
          Save
        </ProgressButton>
      )}
    </>
  );
}

function SharingReadState({ editor }: Readonly<{ editor: Editor }>) {
  if (editor.reader.isError)
    return (
      <Notice
        tone="warning"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={editor.reader.isFetching}
            onClick={() => {
              void editor.reader.refetch();
            }}
          >
            Try again
          </Button>
        }
      >
        {describeReadError(editor.reader.error, 'Folder sharing')}
      </Notice>
    );
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Loading who has access…
    </p>
  );
}

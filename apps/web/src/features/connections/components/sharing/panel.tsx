import { QueryView } from '@/components/patterns/states/query-view';
import { XIcon } from 'lucide-react';
import type { ConnectionMutationScope } from '../../data/connections.mutations';
import type { useConnectionSharingEditor } from '../../hooks/use-sharing-editor';
import { ROLE_NAMES } from '@/features/workspaces/roles.public';
import { SharingModeChoice } from '@/components/patterns/sharing/mode-choice';
import {
  SharingAdministratorsEntry,
  SharingEntry,
} from '@/components/patterns/sharing/entry';
import { SharingPrincipalPicker } from '@/components/patterns/sharing/principal-picker';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { describeReadError } from '@/lib/api/error-copy';

type Editor = ReturnType<typeof useConnectionSharingEditor>;
const MAX_MEMBERS = 100;

/** Who can pick this connection in their steps. Nobody but admins sees the secret. */
export function ConnectionSharingPanel({
  scope,
  editor,
  onDone,
}: Readonly<{
  scope: ConnectionMutationScope;
  editor: Editor;
  onDone: () => void;
}>) {
  const snapshot = editor.snapshot;
  if (snapshot === undefined)
    return (
      <>
        <SharingReadState editor={editor} />
        <Button
          type="button"
          variant="ghost"
          className="self-start"
          onClick={onDone}
        >
          Back
        </Button>
      </>
    );
  const inactive = snapshot.members.some((member) => !member.active);
  return (
    <section
      aria-label="Who can use this connection"
      className="@container flex flex-col gap-5"
    >
      <div>
        <h3 className="font-heading">Who can use this connection?</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          People with access can choose it in their steps. They never see the
          secret.
        </p>
      </div>
      <SharingModeChoice
        legend="Who has access"
        value={snapshot.mode}
        disabled={editor.locked}
        everyone={{
          label: 'Everyone in this workspace',
          hint: 'Anyone whose role can build workflows.',
        }}
        restricted={{
          label: 'Only people you choose',
          hint: 'You, owners and admins always keep access.',
        }}
        onChange={(mode) => {
          editor.update((value) => ({ ...value, mode }));
        }}
      />
      {snapshot.mode === 'restricted' ? (
        <RestrictedConnectionMembers
          scope={scope}
          editor={editor}
          snapshot={snapshot}
        />
      ) : null}
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
          Someone changed who can use this connection while you were editing.
          Reload to see the latest, then make your change again.
        </Notice>
      ) : null}
      {editor.command.error === undefined ? null : (
        <Notice tone="warning">{editor.command.error}</Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
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
            disabled={
              // Nothing changed yet: the snapshot is still the read itself.
              snapshot === editor.reader.data ||
              editor.locked ||
              editor.stale ||
              !editor.reader.isSuccess ||
              (snapshot.mode === 'restricted' && inactive)
            }
            onClick={() => {
              void editor.submit();
            }}
          >
            Save
          </ProgressButton>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={editor.closeLocked}
          onClick={() => {
            editor.discard();
            onDone();
          }}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}

function SharingReadState({ editor }: Readonly<{ editor: Editor }>) {
  return (
    <QueryView
      query={editor.reader}
      resource="Connection sharing"
      loading={
        <p role="status" className="text-sm text-muted-foreground">
          Loading who can use it…
        </p>
      }
      error={({ error, retrying, retry }) => (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={retrying}
              onClick={retry}
            >
              Try again
            </Button>
          }
        >
          {describeReadError(error, 'Connection sharing')}
        </Notice>
      )}
    />
  );
}

function RestrictedConnectionMembers({
  scope,
  editor,
  snapshot,
}: Readonly<{
  scope: ConnectionMutationScope;
  editor: Editor;
  snapshot: NonNullable<Editor['snapshot']>;
}>) {
  return (
    <>
      <ul
        aria-label="People with access"
        className="flex flex-col divide-y divide-border"
      >
        <SharingAdministratorsEntry />
        {snapshot.members.map((member) => (
          <SharingEntry
            key={member.userId}
            kind="member"
            label={member.label}
            detail={
              member.active ? undefined : 'No longer active — remove them'
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={editor.locked}
              aria-label={`Remove ${member.label}`}
              onClick={() => {
                editor.update((value) => ({
                  ...value,
                  members: value.members.filter(
                    (item) => item.userId !== member.userId,
                  ),
                }));
              }}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </SharingEntry>
        ))}
      </ul>
      <SharingPrincipalPicker
        apiClient={scope.apiClient}
        userId={scope.userId}
        workspaceId={scope.workspaceId}
        kinds={['member']}
        roleNames={ROLE_NAMES}
        selected={snapshot.members.map((member) => member.userId)}
        full={snapshot.members.length >= MAX_MEMBERS}
        disabled={editor.locked}
        unavailable={(principal) =>
          principal.kind === 'member' && principal.role === 'viewer'
            ? 'Viewers can’t use connections'
            : undefined
        }
        onAdd={(principal) => {
          if (principal.kind !== 'member') return;
          editor.update((value) =>
            value.members.length >= MAX_MEMBERS ||
            value.members.some((member) => member.userId === principal.userId)
              ? value
              : {
                  ...value,
                  members: [
                    ...value.members,
                    {
                      userId: principal.userId,
                      label: principal.label,
                      active: true,
                    },
                  ],
                },
          );
        }}
      />
    </>
  );
}

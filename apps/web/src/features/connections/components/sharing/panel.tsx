import type { ConnectionMutationScope } from '../../data/connections.mutations';
import type { useConnectionSharingEditor } from '../../hooks/use-sharing-editor';
import { SharingModeField } from '@/components/patterns/sharing/mode-field';
import { SharingPrincipalPicker } from '@/components/patterns/sharing/principal-picker';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { describeReadError } from '@/lib/api/error-copy';
type Editor = ReturnType<typeof useConnectionSharingEditor>;
export function ConnectionSharingPanel({
  scope,
  editor,
}: Readonly<{ scope: ConnectionMutationScope; editor: Editor }>) {
  const snapshot = editor.snapshot;
  if (!snapshot) return <SharingReadState editor={editor} />;
  const inactive = snapshot.members.some((member) => !member.active);
  return (
    <section className="flex flex-col gap-4" aria-label="Connection sharing">
      <h3 className="font-heading">Who can use this connection?</h3>
      <p className="text-sm text-muted-foreground">
        The active creator, owners and admins keep Use. Sharing never reveals
        the secret or grants administration, and workspace roles remain the
        ceiling. Published workflows keep their approved credentials.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (snapshot.mode === 'workspace' || !inactive) void editor.submit();
        }}
      >
        <FieldGroup>
          <SharingModeField
            label="Use"
            restrictedLabel="Selected members"
            value={snapshot.mode}
            disabled={editor.locked}
            onChange={(mode) => {
              editor.update((value) => ({ ...value, mode }));
            }}
          />
          {snapshot.mode === 'restricted' ? (
            <>
              <ConnectionMembers editor={editor} />
              {inactive ? (
                <Notice tone="warning">
                  Inactive members cannot use the connection. Remove their
                  entries before saving another sharing change.
                </Notice>
              ) : null}
              <SharingPrincipalPicker
                apiClient={scope.apiClient}
                userId={scope.userId}
                workspaceId={scope.workspaceId}
                kind="member"
                selected={snapshot.members.map((member) => member.userId)}
                disabled={editor.locked || snapshot.members.length >= 100}
                onAdd={(principal) => {
                  if (
                    principal.kind !== 'member' ||
                    snapshot.members.length >= 100 ||
                    snapshot.members.some(
                      (member) => member.userId === principal.userId,
                    )
                  )
                    return;
                  editor.update((value) => ({
                    ...value,
                    members: [
                      ...value.members,
                      {
                        userId: principal.userId,
                        label: principal.label,
                        active: true,
                      },
                    ],
                  }));
                }}
              />
              <p className="text-xs text-subtle-foreground">
                {snapshot.members.length} of 100 named members. A workspace
                viewer cannot gain Use through sharing.
              </p>
            </>
          ) : null}
          <SharingFeedback editor={editor} />
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
                  editor.locked ||
                  editor.stale ||
                  !editor.reader.isSuccess ||
                  (snapshot.mode === 'restricted' && inactive)
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
function ConnectionMembers({ editor }: Readonly<{ editor: Editor }>) {
  const members = editor.snapshot?.members ?? [];
  if (members.length === 0)
    return (
      <Notice>
        Only the active creator, owners and admins can use this connection.
      </Notice>
    );
  return (
    <ul aria-label="Connection Use grants" className="flex flex-col gap-2">
      {members.map((member) => (
        <li
          key={member.userId}
          className="flex min-w-0 items-center justify-between gap-3"
        >
          <span className="min-w-0 wrap-anywhere">
            {member.label}
            {!member.active ? ' (inactive)' : ''}
          </span>
          <Button
            type="button"
            variant="ghost"
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
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}
function SharingReadState({ editor }: Readonly<{ editor: Editor }>) {
  if (editor.reader.isError)
    return (
      <Notice tone="warning">
        {describeReadError(editor.reader.error, 'Connection sharing')}{' '}
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
  return <p role="status">Loading connection sharing…</p>;
}
function SharingFeedback({ editor }: Readonly<{ editor: Editor }>) {
  return (
    <>
      {editor.stale ? (
        <Notice tone="warning">
          Sharing changed. Your edits have been kept; reload before saving.
        </Notice>
      ) : null}
      {editor.command.error ? (
        <Notice tone="warning">{editor.command.error}</Notice>
      ) : null}
      {editor.reader.isError ? <SharingReadState editor={editor} /> : null}
    </>
  );
}

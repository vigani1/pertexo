import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  NoticeSubscription,
  NoticeSubscriptionRequest,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldLabel as Label } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from '@/components/ui/sheet';
import { notificationSubscriptionQueryOptions } from '../../data/preferences.queries';
import {
  replaceNotificationSubscription,
  type NoticeSubject,
} from '../../data/preferences.api';
import { inboxKeys } from '../../data/inbox.queries';
import { NotificationSaveFeedback } from './feedback';
function SubscriptionEditor({
  scope,
  subject,
  snapshot,
}: {
  scope: WorkspaceApiScope;
  subject: NoticeSubject;
  snapshot: NoticeSubscription;
}) {
  const id = useId();
  const cache = useQueryClient();
  const [draft, setDraft] = useState(snapshot);
  const [saved, setSaved] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string>();
  const command = useRetainedCommand(
    (body: NoticeSubscriptionRequest, key: string) =>
      replaceNotificationSubscription(scope, subject, body, key),
    async (result, body) => {
      cache.setQueryData(
        notificationSubscriptionQueryOptions(scope, subject).queryKey,
        (current) =>
          current !== undefined && current.revision > result.revision
            ? current
            : {
                revision: result.revision,
                followed: body.followed,
                muted: body.muted,
              },
      );
      setDraft({
        revision: result.revision,
        followed: body.followed,
        muted: body.muted,
      });
      setSaved(true);
      await cache.invalidateQueries({
        queryKey: inboxKeys.scope(scope.userId, scope.workspaceId),
      });
    },
    { action: 'saving this personal subscription' },
  );
  const locked = command.pending || command.uncertain || reloading;
  async function reload() {
    setReloading(true);
    try {
      const latest = await cache.query(
        notificationSubscriptionQueryOptions(scope, subject),
      );
      setDraft(latest);
      setSaved(false);
      setError(undefined);
      command.reset();
    } catch {
      setError('Current choices could not be loaded. Your edits are kept.');
    } finally {
      setReloading(false);
    }
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void command.send({
          expectedRevision: draft.revision,
          followed: draft.followed,
          muted: draft.muted,
        });
      }}
    >
      {subject.subjectKind === 'workflow' ? (
        <div className="flex items-center gap-3">
          <Checkbox
            id={`${id}-follow`}
            checked={draft.followed}
            disabled={locked}
            onCheckedChange={(value) => {
              setDraft((current) => ({ ...current, followed: value }));
              setSaved(false);
              command.reset();
            }}
          />
          <Label htmlFor={`${id}-follow`}>Follow this workflow</Label>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Checkbox
          id={`${id}-mute`}
          checked={draft.muted}
          disabled={locked}
          onCheckedChange={(value) => {
            setDraft((current) => ({ ...current, muted: value }));
            setSaved(false);
            command.reset();
          }}
        />
        <Label htmlFor={`${id}-mute`}>Mute its notices for me</Label>
      </div>
      <p className="text-sm text-muted-foreground">
        Following adds its notices to your Inbox. Muting hides associated
        notices and stops their email for you. Shared alerts and pending tasks
        keep working.
      </p>
      {snapshot.revision !== draft.revision ? (
        <Notice tone="warning">
          These choices changed elsewhere. Load the latest before saving.
        </Notice>
      ) : null}
      {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
      <NotificationSaveFeedback
        error={command.error}
        cause={command.cause}
        uncertain={command.uncertain}
        expired={command.expired}
        pending={command.pending}
        retry={command.retry}
        saved={saved}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={locked || snapshot.revision !== draft.revision}
        >
          Save personal choices
        </Button>
        {snapshot.revision !== draft.revision ||
        JSON.stringify(draft) !== JSON.stringify(snapshot) ? (
          <Button
            type="button"
            variant="ghost"
            disabled={locked}
            onClick={() => void reload()}
          >
            {snapshot.revision === draft.revision
              ? 'Discard changes'
              : 'Load the latest choices'}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
function SubscriptionContent({
  scope,
  subject,
}: {
  scope: WorkspaceApiScope;
  subject: NoticeSubject;
}) {
  const query = useQuery(notificationSubscriptionQueryOptions(scope, subject));
  return query.data === undefined ? (
    query.isError ? (
      <Notice
        tone="warning"
        action={<Button onClick={() => void query.refetch()}>Retry</Button>}
      >
        Personal choices could not be loaded.
      </Notice>
    ) : (
      <p role="status">Loading personal choices…</p>
    )
  ) : (
    <SubscriptionEditor scope={scope} subject={subject} snapshot={query.data} />
  );
}
export function NoticeSubjectActions({
  scope,
  subject,
  name,
}: {
  scope: WorkspaceApiScope;
  subject: NoticeSubject;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        Personal notifications…
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Notifications for {name}</SheetTitle>
            <SheetDescription>
              Only your Inbox and email choices change.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            {open ? (
              <SubscriptionContent scope={scope} subject={subject} />
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

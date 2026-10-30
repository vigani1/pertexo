import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { useState } from 'react';
import type { WorkflowComment } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { formatDateTime } from '@/lib/format/time';
import type { CollaborationScope } from '../data/collaboration.api';
import { useDiscussionCommand } from '../data/collaboration.mutations';
import { CommentComposer } from './composer';
import { DiscussionFeedback } from './command-feedback';
export function DiscussionComment({
  scope,
  paused = false,
  comment,
  highlighted,
  onDeleted,
}: {
  scope: CollaborationScope;
  paused?: boolean | undefined;
  comment: WorkflowComment;
  highlighted: boolean;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionRevision, setDeletionRevision] = useState(comment.revision);
  const command = useDiscussionCommand(scope, () => {
    setDeleting(false);
    onDeleted();
  });
  const confirmBlocked =
    command.pending ||
    command.uncertain ||
    deletionRevision !== comment.revision;
  return (
    <li
      id={'comment-' + comment.id}
      className={
        'space-y-3 rounded-md border p-4 ' +
        (highlighted ? 'border-action' : 'border-border')
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong className="text-sm">{comment.authorName}</strong>
        <time
          dateTime={comment.createdAt}
          className="text-xs text-muted-foreground"
        >
          {formatDateTime(comment.createdAt)}
          {comment.editedAt === null ? '' : ' · edited'}
        </time>
      </div>
      {editing ? (
        <CommentComposer
          scope={scope}
          target={{ kind: 'edit', threadId: comment.threadId, comment }}
          onSaved={() => {
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="whitespace-pre-wrap wrap-anywhere text-sm">
            {comment.body}
          </p>
          {comment.mentions.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Mentions:{' '}
              {comment.mentions
                .map((person) => '@' + person.displayName)
                .join(', ')}
            </p>
          ) : null}
          {paused || comment.authorId !== scope.userId ? null : (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(true);
                }}
              >
                Edit comment
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDeletionRevision(comment.revision);
                  setDeleting(true);
                }}
              >
                Delete comment
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        state={{
          open: deleting,
          onOpenChange: setDeleting,
          locked: command.pending || command.uncertain,
        }}
        title="Delete this comment?"
        description="The text and its mentions will be deleted. Other people's replies stay."
        onSubmit={() =>
          void command.send({
            kind: 'remove',
            threadId: comment.threadId,
            commentId: comment.id,
            body: { expectedRevision: deletionRevision },
          })
        }
        submitDisabled={confirmBlocked}
        footer={
          <ConfirmationFooter>
            <DialogClose
              disabled={command.pending || command.uncertain}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
            <ProgressButton
              type="submit"
              variant="primary"
              pending={command.pending}
              pendingLabel="Delete comment"
              disabled={
                command.uncertain || deletionRevision !== comment.revision
              }
            >
              Delete comment
            </ProgressButton>
          </ConfirmationFooter>
        }
      >
        <ConfirmationDetails>
          {deletionRevision === comment.revision ? null : (
            <p role="alert">
              This comment changed. Close and review it before deleting.
            </p>
          )}
          <DiscussionFeedback command={command} />
        </ConfirmationDetails>
      </ConfirmDialog>
    </li>
  );
}

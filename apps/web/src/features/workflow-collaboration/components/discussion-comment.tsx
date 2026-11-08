import {
  commentDraftState,
  type CommentDraftChange,
} from '../model/comment-draft';
import { DialogFooter } from '@/components/ui/dialog';
import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { useEffect, useState } from 'react';
import type { WorkflowComment } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { formatDateTime } from '@/lib/format/time';
import type { CollaborationScope } from '../data/collaboration.api';
import { useDiscussionCommand } from '../data/collaboration.mutations';
import { CommentComposer } from './comment-composer';
import { DiscussionFeedback } from './discussion-feedback';
export function DiscussionComment({
  scope,
  paused = false,
  comment,
  highlighted,
  onDeleted,
  onDraftChange,
  onActiveChange,
  outsidePage,
  onReveal,
}: {
  scope: CollaborationScope;
  paused?: boolean | undefined;
  comment: WorkflowComment;
  highlighted: boolean;
  onDeleted: () => void;
  onDraftChange: CommentDraftChange;
  onActiveChange: (active: boolean) => void;
  outsidePage: boolean;
  onReveal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionRevision, setDeletionRevision] = useState(comment.revision);
  const command = useDiscussionCommand(
    scope,
    () => {
      onDraftChange(`delete:${comment.id}`, 'clean');
      setDeleting(false);
      onActiveChange(false);
      onDeleted();
    },
    (status) => {
      onDraftChange(`delete:${comment.id}`, commentDraftState(false, status));
    },
  );
  useEffect(
    () => () => {
      onDraftChange(`delete:${comment.id}`, 'clean');
    },
    [comment.id, onDraftChange],
  );
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
      <CommentAuthor comment={comment} />
      <RetainedCommentNotice outsidePage={outsidePage} onReveal={onReveal} />
      {editing ? (
        <CommentComposer
          scope={scope}
          onDraftChange={onDraftChange}
          target={{ kind: 'edit', threadId: comment.threadId, comment }}
          onSaved={() => {
            setEditing(false);
            onActiveChange(false);
          }}
          onCancel={() => {
            setEditing(false);
            onActiveChange(false);
          }}
        />
      ) : (
        <>
          <p className="whitespace-pre-wrap wrap-anywhere text-sm">
            {comment.body}
          </p>
          <CommentMentions comment={comment} />
          {paused || comment.authorId !== scope.userId ? null : (
            <CommentEditActions
              onEdit={() => {
                onActiveChange(true);
                setEditing(true);
              }}
              onDelete={() => {
                onActiveChange(true);
                setDeletionRevision(comment.revision);
                setDeleting(true);
              }}
            />
          )}
        </>
      )}
      <ConfirmDialog
        state={{
          open: deleting,
          onOpenChange: (open) => {
            setDeleting(open);
            if (!open) onActiveChange(false);
          },
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
          <DialogFooter>
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
          </DialogFooter>
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

function CommentAuthor({ comment }: Readonly<{ comment: WorkflowComment }>) {
  return (
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
  );
}

function CommentMentions({ comment }: Readonly<{ comment: WorkflowComment }>) {
  return (
    <>
      {' '}
      {comment.mentions.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Mentions:{' '}
          {comment.mentions
            .map((person) => '@' + person.displayName)
            .join(', ')}
        </p>
      ) : null}
    </>
  );
}

function CommentEditActions({
  onEdit,
  onDelete,
}: Readonly<{ onEdit: () => void; onDelete: () => void }>) {
  return (
    <div className="flex gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
        Edit comment
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDelete}>
        Delete comment
      </Button>
    </div>
  );
}

function RetainedCommentNotice({
  outsidePage,
  onReveal,
}: Readonly<{ outsidePage: boolean; onReveal: () => void }>) {
  if (!outsidePage) return null;
  return (
    <p className="text-sm text-muted-foreground">
      This comment is outside the latest reply page. Your edit is kept.{' '}
      <Button variant="ghost" onClick={onReveal}>
        Show this comment
      </Button>
    </p>
  );
}

import { useState } from 'react';
import type {
  WorkflowComment,
  WorkflowCommentCommandResult,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { CollaborationScope } from '../data/collaboration.api';
import { CommentForm } from '../forms/comment';
interface NewThread {
  kind: 'create';
  stepId: string | null;
  steps: readonly { id: string; label: string }[];
}
interface Edit {
  kind: 'edit';
  threadId: string;
  comment: WorkflowComment;
}
interface ComposerProps {
  scope: CollaborationScope;
  target: NewThread | Edit | { kind: 'reply'; threadId: string };
  onSaved: (result: WorkflowCommentCommandResult) => void;
  onCancel?: (() => void) | undefined;
  disabled?: boolean | undefined;
}
export function CommentComposer(props: ComposerProps) {
  if (props.target.kind === 'create')
    return <NewDiscussionComposer {...props} target={props.target} />;
  if (props.target.kind === 'edit')
    return <EditCommentComposer {...props} target={props.target} />;
  const threadId = props.target.threadId;
  return (
    <CommentForm
      {...props}
      title="Reply"
      buildCommand={(body) => ({ kind: 'reply', threadId, body })}
    />
  );
}
function NewDiscussionComposer({
  target,
  ...props
}: Omit<ComposerProps, 'target'> & { target: NewThread }) {
  const [stepId, setStepId] = useState(target.stepId ?? '');
  return (
    <CommentForm
      {...props}
      title="New discussion"
      buildCommand={(body) => ({
        kind: 'create',
        body: { ...body, stepId: stepId === '' ? null : stepId },
      })}
    >
      {(locked) => (
        <label className="block text-sm">
          About{' '}
          <select
            aria-label="Discussion step"
            className="mt-1 block w-full rounded border border-border bg-background p-2"
            value={stepId}
            disabled={locked}
            onChange={(event) => {
              setStepId(event.target.value);
            }}
          >
            <option value="">The workflow</option>
            {target.steps.map((step) => (
              <option key={step.id} value={step.id}>
                {step.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </CommentForm>
  );
}
function EditCommentComposer({
  target,
  ...props
}: Omit<ComposerProps, 'target'> & { target: Edit }) {
  const [revision, setRevision] = useState(target.comment.revision);
  return (
    <CommentForm
      {...props}
      title="Edit comment"
      initial={target.comment}
      buildCommand={(body) => ({
        kind: 'edit',
        threadId: target.threadId,
        commentId: target.comment.id,
        body: { ...body, expectedRevision: revision },
      })}
    >
      {(locked) =>
        target.comment.revision === revision ? null : (
          <Notice tone="warning" className="block">
            <p>
              This comment changed. Review its latest saved text before
              replacing it with your text and mentions.
            </p>
            <p className="mt-2 whitespace-pre-wrap wrap-anywhere">
              {target.comment.body}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              disabled={locked}
              onClick={() => {
                setRevision(target.comment.revision);
              }}
            >
              Use latest revision for my edit
            </Button>
          </Notice>
        )
      }
    </CommentForm>
  );
}

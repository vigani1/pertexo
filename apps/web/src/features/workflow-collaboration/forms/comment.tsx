import {
  commentDraftChanged,
  commentDraftState,
  type CommentDraftChange,
} from '../model/comment-draft';
import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  workflowCommentBodySchema,
  COLLABORATION_LIMITS,
  type WorkflowCommentBody,
  type WorkflowCommentCommandResult,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type {
  CollaborationScope,
  DiscussionCommand,
} from '../data/collaboration.api';
import { useDiscussionCommand } from '../data/collaboration.mutations';
import { DiscussionFeedback } from '../components/command-feedback';
import {
  MentionPicker,
  type MentionPerson,
} from '../components/mention-picker';
import {
  insertMention,
  typedMention,
  type TypedMention,
} from '../model/mentions';
export function CommentForm({
  scope,
  title,
  draftKey,
  onDraftChange,
  initial,
  buildCommand,
  onSaved,
  onCancel,
  disabled = false,
  children,
}: {
  scope: CollaborationScope;
  title: string;
  draftKey: string;
  onDraftChange: CommentDraftChange;
  initial?: Readonly<{ body: string; mentions: readonly MentionPerson[] }>;
  buildCommand: (body: WorkflowCommentBody) => DiscussionCommand;
  onSaved: (result: WorkflowCommentCommandResult) => void;
  onCancel?: (() => void) | undefined;
  disabled?: boolean | undefined;
  children?: (locked: boolean) => ReactNode;
}) {
  const id = useId();
  const [body, setBody] = useState(initial?.body ?? '');
  const [mentions, setMentions] = useState<readonly MentionPerson[]>(
    initial?.mentions ?? [],
  );
  const [validation, setValidation] = useState<string>();
  // Typing "@na" offers members, like Slack and Linear; picking one writes
  // "@Name" into the comment and adds the mention.
  const [typed, setTyped] = useState<TypedMention>();
  const { textarea, placeCaret } = useCommentCaret(body);
  const command = useDiscussionCommand(
    scope,
    (result) => {
      onDraftChange(draftKey, 'clean');
      setBody('');
      setMentions([]);
      onSaved(result);
    },
    (status) => {
      onDraftChange(
        draftKey,
        commentDraftState(commentDraftChanged(body, mentions, initial), status),
      );
    },
  );
  useEffect(
    () => () => {
      onDraftChange(draftKey, 'clean');
    },
    [onDraftChange, draftKey],
  );
  function changeBody(next: string) {
    setBody(next);
    onDraftChange(
      draftKey,
      commentDraftChanged(next, mentions, initial) ? 'dirty' : 'clean',
    );
  }
  function changeMentions(next: readonly MentionPerson[]) {
    setMentions(next);
    onDraftChange(
      draftKey,
      commentDraftChanged(body, next, initial) ? 'dirty' : 'clean',
    );
  }
  const locked = disabled || command.pending || command.uncertain;
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = workflowCommentBodySchema.safeParse({
      body,
      mentionUserIds: mentions.map((person) => person.userId),
    });
    if (!parsed.success) {
      setValidation(
        'Write a comment of up to 8,000 characters and mention each person once.',
      );
      return;
    }
    setValidation(undefined);
    void command.send(buildCommand(parsed.data));
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      {children?.(locked)}
      <label htmlFor={id} className="block text-sm font-medium">
        {title}
      </label>
      <Textarea
        id={id}
        value={body}
        maxLength={COLLABORATION_LIMITS.body}
        rows={4}
        disabled={locked}
        aria-invalid={validation !== undefined}
        aria-describedby={validation === undefined ? undefined : id + '-error'}
        ref={textarea}
        onChange={(event) => {
          changeBody(event.target.value);
          setTyped(
            typedMention(event.target.value, event.target.selectionStart),
          );
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && typed !== undefined) {
            event.preventDefault();
            setTyped(undefined);
          }
        }}
      />
      <CommentValidation id={id} message={validation} />
      <MentionPicker
        scope={scope}
        selected={mentions}
        onChange={changeMentions}
        disabled={locked}
        typed={typed?.query}
        onPicked={(person) => {
          if (typed === undefined) return;
          const caret = textarea.current?.selectionStart ?? body.length;
          const next = insertMention(body, typed, caret, person.displayName);
          placeCaret(next.caret);
          changeBody(next.text);
          setTyped(undefined);
        }}
      />
      <p className="text-xs text-muted-foreground">
        Plain text · Visible to members who can read this workflow
      </p>
      <DiscussionFeedback command={command} />
      <CommentFormActions
        pending={command.pending}
        locked={locked}
        empty={body.trim().length === 0}
        label={commentSubmitLabel(initial !== undefined)}
        onCancel={
          onCancel === undefined
            ? undefined
            : () => {
                onDraftChange(draftKey, 'clean');
                onCancel();
              }
        }
      />
    </form>
  );
}

function CommentFormActions({
  pending,
  locked,
  empty,
  label,
  onCancel,
}: Readonly<{
  pending: boolean;
  locked: boolean;
  empty: boolean;
  label: string;
  onCancel: (() => void) | undefined;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={locked || empty}>
        {pending ? 'Saving…' : label}
      </Button>
      {onCancel === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          disabled={locked}
          onClick={onCancel}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

function useCommentCaret(body: string) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const caretAfterMention = useRef<number>(undefined);
  useLayoutEffect(() => {
    // After the name is written, typing goes on right behind it.
    const caret = caretAfterMention.current;
    if (caret === undefined || textarea.current === null) return;
    caretAfterMention.current = undefined;
    textarea.current.focus();
    textarea.current.setSelectionRange(caret, caret);
  }, [body]);

  return {
    textarea,
    placeCaret: (caret: number) => {
      caretAfterMention.current = caret;
    },
  };
}

function CommentValidation({
  id,
  message,
}: Readonly<{ id: string; message: string | undefined }>) {
  if (message === undefined) return null;
  return (
    <p id={id + '-error'} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

function commentSubmitLabel(editing: boolean): string {
  return editing ? 'Save comment' : 'Post comment';
}

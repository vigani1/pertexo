import {
  useId,
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
  initial,
  buildCommand,
  onSaved,
  onCancel,
  disabled = false,
  children,
}: {
  scope: CollaborationScope;
  title: string;
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
  const command = useDiscussionCommand(scope, (result) => {
    setBody('');
    setMentions([]);
    onSaved(result);
  });
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
  const idleSubmitLabel =
    initial === undefined ? 'Post comment' : 'Save comment';
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
          setBody(event.target.value);
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
      {validation === undefined ? null : (
        <p id={id + '-error'} role="alert" className="text-sm text-destructive">
          {validation}
        </p>
      )}
      <MentionPicker
        scope={scope}
        selected={mentions}
        onChange={setMentions}
        disabled={locked}
        typed={typed?.query}
        onPicked={(person) => {
          if (typed === undefined) return;
          const caret = textarea.current?.selectionStart ?? body.length;
          const next = insertMention(body, typed, caret, person.displayName);
          caretAfterMention.current = next.caret;
          setBody(next.text);
          setTyped(undefined);
        }}
      />
      <p className="text-xs text-muted-foreground">
        Plain text · Visible to members who can read this workflow
      </p>
      <DiscussionFeedback command={command} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={locked || body.trim().length === 0}>
          {command.pending ? 'Saving…' : idleSubmitLabel}
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
    </form>
  );
}

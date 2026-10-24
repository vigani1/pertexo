import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';

/**
 * A setting read as one sentence. "Change" opens its editor in place; the
 * rules behind it wait in "How this works" instead of filling the page.
 */
export function SettingSentence({
  summary,
  rules,
  editor,
  editing,
  onEditingChange,
}: Readonly<{
  /** The current value in words, e.g. "Up to 3 runs at once". */
  summary: ReactNode;
  /** What else is true about the setting, for anyone who asks. */
  rules?: ReactNode;
  /** The form that changes it; without one the sentence only reads. */
  editor?: ReactNode;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}>) {
  const editorId = useId();
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm leading-relaxed text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
          {summary}
        </p>
        {editor === undefined ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-expanded={editing}
            aria-controls={editorId}
            onClick={() => {
              onEditingChange(!editing);
            }}
          >
            {editing ? 'Close' : 'Change'}
          </Button>
        )}
      </div>
      {/* Closed, the editor stays mounted: unsaved edits and an unconfirmed
          save's exact retry are still there when it opens again. */}
      {editor === undefined ? null : (
        <div
          id={editorId}
          hidden={!editing}
          className="rounded-lg border border-border bg-raised/40 p-4"
        >
          {editor}
        </div>
      )}
      {rules === undefined ? null : (
        <Disclosure
          summary="How this works"
          className="text-xs text-muted-foreground"
          appearance={{ size: 'xs' }}
        >
          <div className="mt-2 flex max-w-lg flex-col gap-1.5 leading-relaxed">
            {rules}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

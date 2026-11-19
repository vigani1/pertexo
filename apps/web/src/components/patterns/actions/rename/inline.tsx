import { PencilIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import type { RenameFormProps } from './inline-rename.types';
import { RenameInPlace } from './in-place';

const RENAME_CONFIRMATION_MS = 2_400;

/**
 * A name with a pencil that opens the rename in place. `children` is how
 * the name reads when not editing; render only `children` for people who
 * can't rename. A saved rename ties a knot at the end of the name.
 */
export function InlineRename({
  children,
  textClassName,
  onDraftChange,
  ...form
}: RenameFormProps &
  Readonly<{
    children: ReactNode;
    /** The name's type, so editing keeps its size, weight and face. */
    textClassName?: string;
    /** The name as typed, and `undefined` once editing ends. */
    onDraftChange?: (draft: string | undefined) => void;
  }>) {
  const [editing, setEditing] = useState(false);
  const [knotted, setKnotted] = useState(false);
  // Saving or cancelling closes the field that held focus; focus goes back
  // to the pencil that opened it rather than falling to the page.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!knotted) return;
    const timer = window.setTimeout(() => {
      setKnotted(false);
    }, RENAME_CONFIRMATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [knotted]);
  if (editing)
    return (
      <RenameInPlace
        {...form}
        textClassName={textClassName}
        onDraftChange={onDraftChange}
        onClose={(saved) => {
          returnFocus.current = true;
          setEditing(false);
          setKnotted(saved);
          onDraftChange?.(undefined);
        }}
      />
    );
  return (
    <div className="group/rename flex min-w-0 items-center gap-1">
      {children}
      {knotted ? (
        // The new name is tied off with a knot for a moment.
        <span className="grid size-5 place-items-center text-success">
          <StatusGlyph tone="success" className="motion-safe:animate-knot" />
        </span>
      ) : null}
      <Button
        ref={(element) => {
          if (element === null || !returnFocus.current) return;
          returnFocus.current = false;
          element.focus();
        }}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${form.field.subject}`}
        className="text-subtle-foreground hover:text-foreground"
        onClick={() => {
          setKnotted(false);
          setEditing(true);
          onDraftChange?.(form.value.name);
        }}
      >
        <PencilIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

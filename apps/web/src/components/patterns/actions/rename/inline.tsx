import { PencilIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import type { RenameFormProps } from './contract';
import { RenameInPlace } from './in-place';

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
  useEffect(() => {
    if (!knotted) return;
    const timer = window.setTimeout(() => {
      setKnotted(false);
    }, 2_400);
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
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${form.subject}`}
        className="text-subtle-foreground hover:text-foreground"
        onClick={() => {
          setKnotted(false);
          setEditing(true);
          onDraftChange?.(form.name);
        }}
      >
        <PencilIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

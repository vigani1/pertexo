import { useState } from 'react';
import type { FieldParseResult } from './model/inspector-draft';

type LiveFieldState<Value> = Readonly<{
  text: string;
  applied: Value;
  error: string | undefined;
}>;

/**
 * Text for one inspector field under live apply: every valid value goes
 * straight into the draft through `commit`, while invalid text stays here as
 * scratch with its error. When the stored value changes from elsewhere
 * (undo, redo, a reload) the text follows it; typing never remounts the
 * field, so focus and cursor survive each applied keystroke.
 */
export function useLiveField<Value>({
  value,
  format,
  parse,
  commit,
  onScratchChange,
  equals = Object.is,
}: Readonly<{
  value: Value;
  format: (value: Value) => string;
  parse: (text: string) => FieldParseResult<Value>;
  commit: (value: Value) => void;
  onScratchChange: (hasScratch: boolean) => void;
  equals?: (left: Value, right: Value) => boolean;
}>) {
  const [state, setState] = useState<LiveFieldState<Value>>(() => ({
    text: format(value),
    applied: value,
    error: undefined,
  }));
  let current = state;
  if (!equals(state.applied, value)) {
    // Adjusting state while rendering: the draft moved underneath us.
    current = { text: format(value), applied: value, error: undefined };
    setState(current);
  }

  function change(text: string) {
    const result = parse(text);
    if (result.ok) {
      setState({ text, applied: result.value, error: undefined });
      onScratchChange(false);
      if (!equals(result.value, current.applied)) commit(result.value);
      return;
    }
    setState({ text, applied: current.applied, error: result.error });
    onScratchChange(true);
  }

  return { text: current.text, error: current.error, change } as const;
}

/** Tracks which fields of one inspector form hold unapplied scratch. */
export function createScratchTracker(onChange: (hasScratch: boolean) => void) {
  const fields = new Set<string>();
  return (field: string, hasScratch: boolean) => {
    if (hasScratch) fields.add(field);
    else fields.delete(field);
    onChange(fields.size > 0);
  };
}

import { useState } from 'react';
import type { FieldParseResult } from './model/inspector-draft';

type LiveFieldState<Value, Text> = Readonly<{
  text: Text;
  applied: Value;
  error: string | undefined;
  /** Whether the error is on screen: from leaving the field until it's fixed. */
  shown: boolean;
}>;

/**
 * Text for one inspector field under live apply: every valid value goes
 * straight into the draft through `commit`, while invalid text stays here as
 * scratch. Its error shows once people leave the field (not while they
 * type, so the panel doesn't shift under them) and then follows their
 * typing until it's fixed. When the stored value changes from elsewhere
 * (undo, redo, a reload) the text follows it; typing never remounts the
 * field, so focus and cursor survive each applied keystroke. `Text` is what
 * people edit: a string for one field, or a small draft for a builder.
 */
export function useLiveField<Value, Text = string>({
  value,
  format,
  parse,
  commit,
  onScratchChange,
  equals = Object.is,
}: Readonly<{
  value: Value;
  format: (value: Value) => Text;
  parse: (text: Text) => FieldParseResult<Value>;
  commit: (value: Value) => void;
  onScratchChange: (hasScratch: boolean) => void;
  equals?: (left: Value, right: Value) => boolean;
}>) {
  const [state, setState] = useState<LiveFieldState<Value, Text>>(() => ({
    text: format(value),
    applied: value,
    error: undefined,
    shown: false,
  }));
  let current = state;
  if (!equals(state.applied, value)) {
    // Adjusting state while rendering: the draft moved underneath us.
    current = {
      text: format(value),
      applied: value,
      error: undefined,
      shown: false,
    };
    setState(current);
  }

  function change(text: Text) {
    const result = parse(text);
    if (result.ok) {
      setState({ text, applied: result.value, error: undefined, shown: false });
      onScratchChange(false);
      if (!equals(result.value, current.applied)) commit(result.value);
      return;
    }
    setState({
      text,
      applied: current.applied,
      error: result.error,
      shown: current.shown,
    });
    onScratchChange(true);
  }

  function blur() {
    if (current.error !== undefined && !current.shown)
      setState({ ...current, shown: true });
  }

  return {
    text: current.text,
    error: current.shown ? current.error : undefined,
    change,
    /** Leaving the field shows its error, if it has one. */
    blur,
  } as const;
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

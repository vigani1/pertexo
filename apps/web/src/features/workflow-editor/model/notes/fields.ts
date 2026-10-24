import {
  WORKFLOW_NOTE_LIMITS as limits,
  type WorkflowNote,
} from '@pertexo/workflow-model';
import type { FieldErrors } from '@/components/ui/use-field-validation';
export type NoteFields = Readonly<{
  text: string;
  color: WorkflowNote['color'];
  x: string;
  y: string;
  width: string;
  height: string;
}>;
// Dragging leaves fractional canvas pixels; people read and type whole ones.
const shown = (value: number): string => String(Math.round(value));

export function noteFields(note: WorkflowNote): NoteFields {
  return {
    text: note.text,
    color: note.color,
    x: shown(note.position.x),
    y: shown(note.position.y),
    width: shown(note.size.width),
    height: shown(note.size.height),
  };
}
export function noteFieldErrors(
  fields: NoteFields,
): FieldErrors<keyof NoteFields> {
  const errors: Partial<Record<keyof NoteFields, string>> = {};
  if (fields.text.length > limits.textLength)
    errors.text = `Keep the note within ${String(limits.textLength)} characters.`;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = Number(fields[key]);
    const minimum = MINIMUMS[key];
    const maximum =
      key === 'width' || key === 'height' ? limits.maxSize : limits.coordinate;
    const invalidSizeField =
      fields[key].trim() === '' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum;
    if (invalidSizeField)
      errors[key] =
        `Use a number from ${String(minimum)} to ${String(maximum)}.`;
  }
  return errors;
}
export function appliedNote(
  note: WorkflowNote,
  fields: NoteFields,
): WorkflowNote {
  return {
    ...note,
    text: fields.text,
    color: fields.color,
    position: {
      x: kept(fields.x, note.position.x),
      y: kept(fields.y, note.position.y),
    },
    size: {
      width: kept(fields.width, note.size.width),
      height: kept(fields.height, note.size.height),
    },
  };
}

/** A field left as shown keeps the exact stored value, so saving text never nudges the note. */
function kept(field: string, stored: number): number {
  return field === shown(stored) ? stored : Number(field);
}

const MINIMUMS = {
  width: limits.minWidth,
  height: limits.minHeight,
  x: -limits.coordinate,
  y: -limits.coordinate,
};

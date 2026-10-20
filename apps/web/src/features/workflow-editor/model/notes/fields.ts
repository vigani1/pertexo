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
export function noteFields(note: WorkflowNote): NoteFields {
  return {
    text: note.text,
    color: note.color,
    x: String(note.position.x),
    y: String(note.position.y),
    width: String(note.size.width),
    height: String(note.size.height),
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
    const minimum =
      key === 'width'
        ? limits.minWidth
        : key === 'height'
          ? limits.minHeight
          : -limits.coordinate;
    const maximum =
      key === 'width' || key === 'height' ? limits.maxSize : limits.coordinate;
    if (
      fields[key].trim() === '' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    )
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
    position: { x: Number(fields.x), y: Number(fields.y) },
    size: { width: Number(fields.width), height: Number(fields.height) },
  };
}

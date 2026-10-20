import { z } from 'zod';

export const WORKFLOW_NOTE_LIMITS = Object.freeze({
  count: 100,
  textLength: 4_000,
  coordinate: 100_000,
  minWidth: 200,
  minHeight: 120,
  maxSize: 1_200,
  defaultWidth: 320,
  defaultHeight: 200,
});

export const workflowNoteColorSchema = z.enum([
  'neutral',
  'teal',
  'violet',
  'sage',
  'amber',
]);
export type WorkflowNoteColor = z.output<typeof workflowNoteColorSchema>;
export type WorkflowNote = Readonly<{
  id: string;
  text: string;
  position: Readonly<{ x: number; y: number }>;
  size: Readonly<{ width: number; height: number }>;
  color: WorkflowNoteColor;
}>;
const coordinate = z
  .number()
  .min(-WORKFLOW_NOTE_LIMITS.coordinate)
  .max(WORKFLOW_NOTE_LIMITS.coordinate);
export const workflowNoteSchema: z.ZodType<WorkflowNote> = z
  .object({
    id: z.uuid(),
    text: z.string().max(WORKFLOW_NOTE_LIMITS.textLength),
    position: z.object({ x: coordinate, y: coordinate }).strict(),
    size: z
      .object({
        width: z
          .number()
          .min(WORKFLOW_NOTE_LIMITS.minWidth)
          .max(WORKFLOW_NOTE_LIMITS.maxSize),
        height: z
          .number()
          .min(WORKFLOW_NOTE_LIMITS.minHeight)
          .max(WORKFLOW_NOTE_LIMITS.maxSize),
      })
      .strict(),
    color: workflowNoteColorSchema,
  })
  .strict();

export const workflowNotesSchema = z
  .array(workflowNoteSchema)
  .max(WORKFLOW_NOTE_LIMITS.count)
  .superRefine((notes, context) => {
    const ids = new Set<string>();
    notes.forEach((note, index) => {
      if (ids.has(note.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Each canvas note must have its own ID.',
        });
      ids.add(note.id);
    });
  });

import { useState } from 'react';
import {
  WORKFLOW_NOTE_LIMITS as limits,
  workflowNoteColorSchema,
  type WorkflowNote,
} from '@pertexo/workflow-model';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { LabelledField, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
} from '@/components/ui/select';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import {
  noteFields,
  noteFieldErrors,
  appliedNote,
  type NoteFields,
} from '../../../model/notes/fields';

const colors = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'teal', label: 'Teal' },
  { value: 'violet', label: 'Violet' },
  { value: 'sage', label: 'Sage' },
  { value: 'amber', label: 'Amber' },
] as const;
const geometry = [
  {
    key: 'x',
    label: 'Horizontal position',
    min: -limits.coordinate,
    max: limits.coordinate,
  },
  {
    key: 'y',
    label: 'Vertical position',
    min: -limits.coordinate,
    max: limits.coordinate,
  },
  { key: 'width', label: 'Width', min: limits.minWidth, max: limits.maxSize },
  {
    key: 'height',
    label: 'Height',
    min: limits.minHeight,
    max: limits.maxSize,
  },
] as const;
export function NoteForm({
  note,
  onClose,
  onApply,
  onRemove,
}: Readonly<{
  note: WorkflowNote;
  onClose: () => void;
  onApply: (note: WorkflowNote) => void;
  onRemove?: () => void;
}>) {
  const [fields, setFields] = useState(() => noteFields(note));
  const validation = useFieldValidation<keyof NoteFields>();
  const geometryInvalid = geometry.some(
    (field) => validation.error(field.key) !== undefined,
  );
  function change<Key extends keyof NoteFields>(
    key: Key,
    value: NoteFields[Key],
  ) {
    const next = { ...fields, [key]: value };
    setFields(next);
    validation.change(key, noteFieldErrors(next)[key]);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <div className="flex flex-col gap-2">
          <DialogTitle>Edit note</DialogTitle>
          <DialogDescription>
            Documentation for this workflow. Saving updates the draft; notes
            never run.
          </DialogDescription>
        </div>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (validation.submit(noteFieldErrors(fields)))
              onApply(appliedNote(note, fields));
          }}
          onKeyDown={(event) => {
            const noteSaveRequested =
              (event.metaKey || event.ctrlKey) &&
              (event.key === 'Enter' || event.key.toLowerCase() === 's');
            if (noteSaveRequested) {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.requestSubmit();
            }
          }}
        >
          <FieldGroup>
            <LabelledField
              id="note-text"
              label="Note"
              description="Markdown: # heading, **bold**, *italic*, lists, code and links. Images and HTML stay out."
              error={validation.error('text')}
            >
              {(control) => (
                <Textarea
                  {...control}
                  ref={validation.register('text')}
                  value={fields.text}
                  onChange={(event) => {
                    change('text', event.currentTarget.value);
                  }}
                  maxLength={limits.textLength}
                  rows={7}
                  placeholder="Explain why this part of the workflow exists…"
                />
              )}
            </LabelledField>
            <LabelledField id="note-color" label="Colour">
              {(control) => (
                <Select
                  items={colors}
                  value={fields.color}
                  onValueChange={(value) => {
                    const parsed = workflowNoteColorSchema.safeParse(value);
                    if (parsed.success) change('color', parsed.data);
                  }}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {colors.map((color) => (
                        <SelectItem key={color.value} value={color.value}>
                          {color.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            </LabelledField>
            {/* Dragging and the keyboard move notes on the canvas; exact
                numbers are the rare case, so they stay folded and the
                dialog's buttons stay in view on a phone. */}
            <Disclosure
              key={geometryInvalid ? 'invalid' : 'valid'}
              summary="Position and size"
              defaultOpen={geometryInvalid}
              contentClassName="grid grid-cols-2 gap-4 pt-1"
            >
              <p className="col-span-2 text-xs text-muted-foreground">
                In canvas pixels.
              </p>
              {geometry.map((field) => (
                <LabelledField
                  key={field.key}
                  id={`note-${field.key}`}
                  label={field.label}
                  error={validation.error(field.key)}
                >
                  {(control) => (
                    <Input
                      {...control}
                      ref={validation.register(field.key)}
                      type="number"
                      min={field.min}
                      max={field.max}
                      step="any"
                      value={fields[field.key]}
                      onChange={(event) => {
                        change(field.key, event.currentTarget.value);
                      }}
                    />
                  )}
                </LabelledField>
              ))}
            </Disclosure>
          </FieldGroup>
          <div className="flex flex-wrap justify-end gap-2">
            {onRemove === undefined ? null : (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive"
                onClick={onRemove}
              >
                Delete note
              </Button>
            )}
            {/* Cancel and Save wrap as a pair, never Save alone. */}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                Save note
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

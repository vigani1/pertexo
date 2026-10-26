import { PencilIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { StatusGlyph } from '@/components/ui/status';
import { FileChip } from '@/features/artifacts/public';
import { cn } from '@/lib/utils';
import { directPredecessorOptions } from '../../../model/inspector/input-mappings/draft';
import { describeMappingSource } from '../../../model/inspector/mapping-summary';
import {
  attachmentName,
  literalFile,
  type AttachmentDraft,
} from '../../../model/inspector/object-mappings/attachments';
import {
  MappingValueEditor,
  type MappingSources,
} from '../input-mappings/value-editor';

type AttachmentRowProps = Readonly<{
  row: AttachmentDraft;
  position: Readonly<{ index: number; count: number }>;
  /** Shown once people have left the unfinished row. */
  error: string | undefined;
  editable: boolean;
  open: boolean;
  context: Omit<MappingSources, 'predecessors'>;
  onToggle: () => void;
  onChange: (row: AttachmentDraft) => void;
  onRemove: () => void;
}>;

/**
 * One attached file as a chip: its type, the name recipients see and its
 * size when known. The pencil opens a rename and the source it comes from.
 */
export function AttachmentRow({
  row,
  position,
  error,
  editable,
  open,
  context,
  onToggle,
  onChange,
  onRemove,
}: AttachmentRowProps) {
  const file = literalFile(row);
  const naming = attachmentName(row, position);
  const label = naming.name ?? `attachment ${String(position.index + 1)}`;
  const editorId = `${context.nodeId}-${row.id}-editor`;
  const errorId = `${context.nodeId}-${row.id}-error`;
  const detail =
    file === undefined
      ? `from ${describeMappingSource(row.file, context.graph).label}`
      : 'Uploaded file';
  return (
    <li className="flex min-w-0 flex-col gap-2">
      <FileChip
        name={naming.name}
        unnamedLabel="Named from its type when sent"
        mediaType={file?.mediaType}
        byteLength={file?.byteLength}
        detail={detail}
        className={cn(
          error !== undefined && 'border-destructive/45',
          open && 'border-action/40',
        )}
        actions={
          <>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${label}`}
              aria-expanded={open}
              aria-controls={editorId}
              aria-describedby={error === undefined ? undefined : errorId}
              onClick={onToggle}
            >
              <PencilIcon />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${label}`}
              disabled={!editable}
              onClick={onRemove}
            >
              <XIcon />
            </Button>
          </>
        }
      />
      {error === undefined ? null : (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-xs text-destructive"
        >
          <StatusGlyph tone="failure" className="mt-px shrink-0" />
          {error}
        </p>
      )}
      <div
        id={editorId}
        hidden={!open}
        className="ml-3 flex min-w-0 flex-col gap-3 border-l border-surface-ink/10 pb-1 pl-3"
      >
        {open ? (
          <>
            <LabelledField
              id={`${context.nodeId}-${row.id}-filename`}
              label="Name in the email"
              description="Optional. Leave it empty to name the file from its type."
            >
              {(control) => (
                <Input
                  {...control}
                  value={row.filename}
                  placeholder={
                    naming.chosen
                      ? undefined
                      : (naming.name ?? 'Named from its type, like report.csv')
                  }
                  maxLength={255}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!editable}
                  onChange={(event) => {
                    onChange({ ...row, filename: event.currentTarget.value });
                  }}
                />
              )}
            </LabelledField>
            <MappingValueEditor
              row={row.file}
              type="object"
              error={undefined}
              disabled={!editable}
              onChange={(next) => {
                onChange({ ...row, file: next });
              }}
              context={{
                ...context,
                predecessors: directPredecessorOptions(
                  context.graph,
                  context.nodeId,
                ),
              }}
            />
          </>
        ) : null}
      </div>
    </li>
  );
}

import { RotateCcwIcon, XIcon } from 'lucide-react';
import type { Ref } from 'react';
import { Button } from '@/components/ui/button';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/utils';
import { fileGroupOf } from '../../model/files';
import { phaseLabel, type UploadRow } from '../../model/uploads';
import { FileGroupGlyph } from './glyph';
import { UploadRing } from './ring';

/** One chosen file: its kind, name and size, where its upload is, and why not. */
export function FileRow({
  row,
  disabled,
  removeRef,
  onRemove,
  onRetry,
}: Readonly<{
  row: UploadRow;
  disabled: boolean;
  removeRef?: Ref<HTMLButtonElement>;
  onRemove: () => void;
  onRetry: () => void;
}>) {
  const failed = row.phase === 'failed';
  return (
    <li
      className={cn(
        'flex min-h-14 min-w-0 items-center gap-3 rounded-lg border bg-card py-2 pr-1.5 pl-3 transition-colors motion-reduce:transition-none',
        failed ? 'border-destructive/35' : 'border-surface-ink/8',
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md border border-surface-ink/8 bg-surface-ink/[0.03] text-muted-foreground">
        <FileGroupGlyph group={fileGroupOf(row.name)} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={row.name}>
          {row.name}
        </p>
        <p
          className={cn(
            'text-[0.75rem] leading-snug',
            failed ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          <span className="font-mono tabular-nums">
            {formatByteLength(row.size)}
          </span>
          {' · '}
          {failed ? row.error : phaseLabel(row.phase)}
        </p>
      </div>
      <UploadRing phase={row.phase} />
      <div className="flex shrink-0 items-center">
        {failed && row.retryable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-11"
            disabled={disabled}
            aria-label={`Retry ${row.name}`}
            onClick={onRetry}
          >
            <RotateCcwIcon aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          ref={removeRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          className="max-sm:size-11"
          disabled={disabled}
          aria-label={`Remove ${row.name}`}
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

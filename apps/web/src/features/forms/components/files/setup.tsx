import { MinusIcon, PlusIcon } from 'lucide-react';
import {
  FORM_FILE_LIMITS,
  formatFormFileBytes,
  type FormFileGroup,
} from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FILE_GROUPS, type FileField } from '../../model/files';
import { FileGroupGlyph } from './glyph';

const MEBIBYTE = 1_048_576;
const MAX_MEGABYTES = FORM_FILE_LIMITS.maxBytes / MEBIBYTE;
const TICKS = [1, 5, 10] as const;

/** What a file question takes: kinds of file, how many, and how large. */
export function FileFieldSetup({
  field,
  id,
  onChange,
}: Readonly<{
  field: FileField;
  id: string;
  onChange: (
    change: Partial<Pick<FileField, 'accept' | 'maxFiles' | 'maxBytes'>>,
  ) => void;
}>) {
  const prefix = `${id}-${field.id}`;
  const megabytes = Math.max(1, Math.round(field.maxBytes / MEBIBYTE));
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-surface-ink/8 bg-surface-ink/[0.02] p-3">
      <div className="flex min-w-0 flex-col gap-2">
        <span
          id={`${prefix}-accept`}
          className="text-[0.8rem] font-semibold text-foreground/85"
        >
          Accepts
        </span>
        <ToggleGroup
          multiple
          aria-labelledby={`${prefix}-accept`}
          value={[...field.accept]}
          onValueChange={(value: unknown[]) => {
            const accept = FILE_GROUPS.map(({ group }) => group).filter(
              (group) => value.includes(group),
            );
            // At least one kind stays chosen; a field that takes nothing is no question.
            if (accept.length > 0) onChange({ accept });
          }}
          className="flex w-full flex-wrap gap-1.5 border-0 bg-transparent p-0"
        >
          {FILE_GROUPS.map(({ group, label }) => (
            <AcceptPill key={group} group={group} label={label} />
          ))}
        </ToggleGroup>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span
            id={`${prefix}-count`}
            className="text-[0.8rem] font-semibold text-foreground/85"
          >
            Files per response
          </span>
          <div
            role="group"
            aria-labelledby={`${prefix}-count`}
            className="flex items-center gap-1"
          >
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="max-sm:size-11"
              aria-label="Fewer files"
              disabled={field.maxFiles <= 1}
              onClick={() => {
                onChange({ maxFiles: field.maxFiles - 1 });
              }}
            >
              <MinusIcon aria-hidden="true" />
            </Button>
            <output
              aria-live="polite"
              className="min-w-24 text-center text-sm tabular-nums"
            >
              Up to {field.maxFiles} {field.maxFiles === 1 ? 'file' : 'files'}
            </output>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="max-sm:size-11"
              aria-label="More files"
              disabled={field.maxFiles >= FORM_FILE_LIMITS.maxFiles}
              onClick={() => {
                onChange({ maxFiles: field.maxFiles + 1 });
              }}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <label
              htmlFor={`${prefix}-size`}
              className="text-[0.8rem] font-semibold text-foreground/85"
            >
              Largest file
            </label>
            <span className="font-mono text-[0.8rem] tabular-nums">
              {formatFormFileBytes(megabytes * MEBIBYTE)}
            </span>
          </div>
          <input
            id={`${prefix}-size`}
            type="range"
            min={1}
            max={MAX_MEGABYTES}
            step={1}
            value={megabytes}
            aria-valuetext={`${String(megabytes)} MB`}
            className="h-6 w-full cursor-pointer accent-action max-sm:h-11"
            onChange={(event) => {
              onChange({ maxBytes: Number(event.target.value) * MEBIBYTE });
            }}
          />
          <div aria-hidden="true" className="relative h-5 text-[0.7rem]">
            {TICKS.map((tick) => (
              <SizeTick key={tick} megabytes={tick} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AcceptPill({
  group,
  label,
}: Readonly<{ group: FormFileGroup; label: string }>) {
  return (
    <ToggleGroupItem
      value={group}
      className="h-8 rounded-full border border-surface-ink/10 px-3 data-pressed:border-action/55 data-pressed:bg-action/12 data-pressed:text-foreground"
    >
      <FileGroupGlyph group={group} />
      {label}
    </ToggleGroupItem>
  );
}

/** A labelled mark under the slider, where the thumb sits for that size. */
function SizeTick({ megabytes }: Readonly<{ megabytes: number }>) {
  const first = megabytes === 1;
  const last = megabytes === MAX_MEGABYTES;
  // The thumb's centre travels inside half a thumb (0.5rem) of each edge.
  const centre = `calc(0.5rem + (100% - 1rem) * ${String((megabytes - 1) / (MAX_MEGABYTES - 1))})`;
  return (
    <span
      className={cn(
        'absolute top-0 flex flex-col font-mono whitespace-nowrap text-subtle-foreground',
        first && 'left-0 items-start',
        last && 'right-0 items-end',
        !first && !last && '-translate-x-1/2 items-center',
      )}
      style={first || last ? undefined : { left: centre }}
    >
      <span
        className={cn('h-1 w-px bg-current', first && 'ml-2', last && 'mr-2')}
      />
      {megabytes} MB
    </span>
  );
}

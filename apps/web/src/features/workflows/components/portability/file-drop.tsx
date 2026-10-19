import { connectionSlotKey } from '../../model/portability';
import type { WorkflowPortableManifest } from '@pertexo/workflow-model';
import { useId, useState, type DragEvent, type Ref } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import { SkeletonThread } from '@/components/ui/skeleton';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/utils';
import { PatternGlyph } from '../pattern-glyph';

/**
 * Where a workflow file comes in: a frame to drop it on or choose it from,
 * that becomes the file once it's read, drawn as its own thread.
 */
export function WorkflowFileDrop({
  inputRef,
  error,
  locked,
  reading,
  manifest,
  optionalSlots,
  onChoose,
}: Readonly<{
  inputRef: Ref<HTMLInputElement>;
  error: string | undefined;
  locked: boolean;
  reading: boolean;
  /** The file's workflow once read; a chosen example doesn't count. */
  manifest: WorkflowPortableManifest | undefined;
  optionalSlots: ReadonlySet<string>;
  onChoose: (file: File | undefined) => void;
}>) {
  const id = useId();
  const [file, setFile] = useState<Readonly<{ name: string; size: number }>>();
  const [dragging, setDragging] = useState(false);

  function choose(next: File | undefined) {
    setFile(
      next === undefined ? undefined : { name: next.name, size: next.size },
    );
    onChoose(next);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!locked) choose(event.dataTransfer.files[0]);
  }

  const read = manifest !== undefined && file !== undefined;
  const steps = manifest?.graph.nodes.length ?? 0;
  // Steps that run without a connection don't count as needing one.
  const slots =
    manifest?.connectionSlots.filter(
      (slot) => !optionalSlots.has(connectionSlotKey(slot.nodeId, slot.slot)),
    ).length ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        onDragOver={(event) => {
          if (locked) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={drop}
        className={cn(
          'relative flex items-center gap-4 rounded-xl border border-dashed px-4 py-4 transition-colors motion-reduce:transition-none',
          dragging
            ? 'border-action bg-action/[0.06]'
            : error === undefined
              ? 'border-border-strong bg-white/[0.015]'
              : 'border-destructive/70 bg-destructive/[0.04]',
          read && !dragging && 'border-solid border-border',
        )}
      >
        <span
          aria-hidden="true"
          className="grid h-12 w-[8.25rem] shrink-0 place-items-center rounded-md bg-black/25"
        >
          {read ? <PatternGlyph graph={manifest.graph} /> : <UnwovenThread />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {reading ? (
            <>
              <p className="text-sm text-foreground" role="status">
                Reading {file?.name ?? 'the file'}…
              </p>
              <SkeletonThread className="w-40" />
            </>
          ) : read ? (
            <>
              <p className="truncate text-sm font-semibold text-foreground">
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {steps === 1 ? '1 step' : `${String(steps)} steps`}
                {slots === 0
                  ? ''
                  : ` · needs ${slots === 1 ? 'a connection' : `${String(slots)} connections`}`}
                {' · '}
                <span className="font-mono">{formatByteLength(file.size)}</span>
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-foreground">
                {dragging ? 'Release to read it' : 'Drop a workflow file here'}
              </p>
              <p className="text-xs text-muted-foreground">
                A JSON file exported from Pertexo, up to 2 MB.
              </p>
            </>
          )}
        </div>
        <input
          ref={inputRef}
          id={`${id}-file`}
          aria-label="Workflow JSON file"
          name="workflow-file"
          type="file"
          accept=".json,application/json"
          disabled={locked}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : `${id}-error`}
          className="peer sr-only"
          onChange={(event) => {
            choose(event.target.files?.[0]);
          }}
        />
        <label
          htmlFor={`${id}-file`}
          className={cn(
            buttonVariants({ variant: read ? 'ghost' : 'outline', size: 'sm' }),
            'shrink-0 cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:pointer-events-none peer-disabled:opacity-50',
          )}
        >
          {read ? 'Choose another' : 'Choose file'}
        </label>
      </div>
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** No file yet: a thread with a loose end, waiting to be woven in. */
function UnwovenThread() {
  return (
    <svg
      viewBox="0 0 120 32"
      width={120}
      height={32}
      className="block"
      fill="none"
      strokeLinecap="round"
    >
      <path
        d="M8 16H58c10 0 12-9 22-9s12 13 22 13"
        strokeWidth={1.2}
        className="stroke-white/20 [stroke-dasharray:3_4]"
      />
      <circle
        cx={8}
        cy={16}
        r={2.6}
        strokeWidth={1.1}
        className="stroke-subtle-foreground"
      />
    </svg>
  );
}

import { connectionSlotKey } from '../../model/portability';
import type { WorkflowPortableManifest } from '@pertexo/workflow-model';
import type { Ref } from 'react';
import { FileDrop } from '@/components/ui/file-drop';
import { SkeletonThread } from '@/components/ui/skeleton';
import { formatByteLength } from '@/lib/format/bytes';
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
  const steps = manifest?.graph.nodes.length ?? 0;
  // Steps that run without a connection don't count as needing one.
  const slots =
    manifest?.connectionSlots.filter(
      (slot) => !optionalSlots.has(connectionSlotKey(slot.nodeId, slot.slot)),
    ).length ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <FileDrop
        ref={inputRef}
        aria-label="Workflow JSON file"
        name="workflow-file"
        accept=".json,application/json"
        disabled={locked}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={
          error === undefined ? undefined : 'workflow-file-error'
        }
        onChoose={onChoose}
      >
        {({ file, dragging }) => {
          const selection = { manifest, file };
          return (
            <div className="flex min-w-0 flex-1 flex-col items-start gap-3 sm:flex-row sm:items-center">
              <span
                aria-hidden="true"
                className="grid h-12 w-24 shrink-0 place-items-center rounded-md bg-recess-ink/25 sm:w-[8.25rem]"
              >
                {isReadSelection(selection) ? (
                  <PatternGlyph graph={selection.manifest.graph} />
                ) : (
                  <UnwovenThread />
                )}
              </span>
              <div className="flex w-full min-w-0 flex-1 flex-col gap-1 sm:w-auto">
                <FileSummary
                  selection={selection}
                  reading={reading}
                  dragging={dragging}
                  steps={steps}
                  slots={slots}
                />
              </div>
              <span className="text-sm font-semibold text-accent-foreground">
                {file ? 'Choose another' : 'Choose file'}
              </span>
            </div>
          );
        }}
      </FileDrop>
      {error === undefined ? null : (
        <p id="workflow-file-error" className="text-xs text-destructive">
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
        className="stroke-surface-ink/20 [stroke-dasharray:3_4]"
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

type SelectedFile = Readonly<Pick<File, 'name' | 'size'>>;
type FileSelection = Readonly<{
  file: SelectedFile | undefined;
  manifest: WorkflowPortableManifest | undefined;
}>;

function isReadSelection(selection: FileSelection): selection is Readonly<{
  file: SelectedFile;
  manifest: WorkflowPortableManifest;
}> {
  return selection.manifest !== undefined && selection.file !== undefined;
}

function FileSummary({
  selection,
  reading,
  dragging,
  steps,
  slots,
}: Readonly<{
  selection: FileSelection;
  reading: boolean;
  dragging: boolean;
  steps: number;
  slots: number;
}>) {
  if (reading)
    return (
      <>
        <p className="text-sm text-foreground" role="status">
          Reading {selection.file?.name ?? 'the file'}…
        </p>
        <SkeletonThread className="w-40" />
      </>
    );
  if (isReadSelection(selection))
    return (
      <>
        <p className="wrap-anywhere text-sm font-semibold text-foreground">
          {selection.file.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {steps === 1 ? '1 step' : `${String(steps)} steps`}
          {slots === 0
            ? ''
            : ` · needs ${slots === 1 ? 'a connection' : `${String(slots)} connections`}`}
          {' · '}
          <span className="font-mono">
            {formatByteLength(selection.file.size)}
          </span>
        </p>
      </>
    );
  return (
    <>
      <p className="text-sm text-foreground">
        {dragging
          ? 'Release to read it'
          : (selection.file?.name ?? 'Drop a workflow file here')}
      </p>
      <p className="text-xs text-muted-foreground">
        {selection.file
          ? formatByteLength(selection.file.size)
          : 'A JSON file exported from Pertexo, up to 2 MB.'}
      </p>
    </>
  );
}

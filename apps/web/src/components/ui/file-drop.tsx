import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { UploadIcon } from 'lucide-react';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/utils';

type FileDropState = Readonly<{
  file: File | undefined;
  dragging: boolean;
}>;

/** The native input owns keyboard/file-picker access; the same choice handles drops. */
export function FileDrop({
  id,
  disabled,
  className,
  children,
  onChoose,
  ...inputProps
}: Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'children' | 'value'> &
  Readonly<{
    onChoose: (file: File) => void;
    children?: (state: FileDropState) => ReactNode;
  }>) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  function choose(next: File | undefined) {
    if (disabled || next === undefined) return;
    setFile(next);
    onChoose(next);
  }
  return (
    <div
      data-slot="file-drop"
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        choose(event.dataTransfer.files[0]);
      }}
      className={cn(
        'relative flex min-h-28 min-w-0 items-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface-ink/[0.015] p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring motion-reduce:transition-none',
        !disabled && 'hover:border-action/60 hover:bg-action/[0.04]',
        dragging && 'border-action bg-action/[0.06]',
        disabled && 'opacity-50',
        className,
      )}
    >
      <input
        {...inputProps}
        id={inputId}
        type="file"
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          choose(event.currentTarget.files?.[0]);
          // The same file can be chosen again after a read or validation failure.
          event.currentTarget.value = '';
        }}
      />
      <label
        htmlFor={inputId}
        className={cn(
          'absolute inset-0 rounded-xl',
          disabled ? 'cursor-default' : 'cursor-pointer',
        )}
      >
        <span className="sr-only">Choose file</span>
      </label>
      <div
        className="pointer-events-none flex w-full min-w-0 items-center gap-3"
        aria-live="polite"
      >
        {children ? (
          children({ file, dragging })
        ) : (
          <>
            <UploadIcon
              aria-hidden="true"
              className="size-5 shrink-0 text-action"
            />
            <div className="min-w-0 text-sm">
              <p className="wrap-anywhere font-medium">
                {dragging
                  ? 'Drop to choose this file'
                  : (file?.name ?? 'Drop a file here or choose file')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {file
                  ? formatByteLength(file.size)
                  : 'Click or use the keyboard to browse your files.'}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

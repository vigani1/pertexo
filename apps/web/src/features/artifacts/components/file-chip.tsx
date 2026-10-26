import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/utils';
import { fileTypeTag, type FileFamily } from '../model/artifact-labels';

// The same family tints as step tiles: data mint, documents ice, images
// lavender. The tag carries the meaning; the colour only groups.
const glyphVariants = cva(
  'relative grid h-8 w-6.5 shrink-0 place-items-end justify-center pb-[0.3rem]',
  {
    variants: {
      family: {
        data: 'text-success',
        document: 'text-accent-foreground',
        image: 'text-secondary',
        archive: 'text-muted-foreground',
        other: 'text-subtle-foreground',
      } satisfies Record<FileFamily, string>,
    },
  },
);

/** A page with a folded corner and the file's type set in mono. */
export function FileGlyph({
  mediaType,
  name,
  className,
}: Readonly<{
  mediaType: string | undefined;
  name?: string | undefined;
  className?: string;
}>) {
  const { tag, family } = fileTypeTag(mediaType, name);
  return (
    <span
      aria-hidden="true"
      className={cn(glyphVariants({ family }), className)}
    >
      <svg
        viewBox="0 0 26 32"
        className="absolute inset-0 size-full overflow-visible"
      >
        <path
          d="M5 .75h11.25L25.25 9.75V27a4.25 4.25 0 0 1-4.25 4.25H5A4.25 4.25 0 0 1 .75 27V5A4.25 4.25 0 0 1 5 .75Z"
          className="fill-[color-mix(in_srgb,currentColor_9%,transparent)] stroke-[color-mix(in_srgb,currentColor_38%,transparent)]"
          strokeWidth="1.5"
        />
        <path
          d="M16.25.75V6a3.75 3.75 0 0 0 3.75 3.75h5.25"
          className="fill-[color-mix(in_srgb,currentColor_16%,transparent)] stroke-[color-mix(in_srgb,currentColor_38%,transparent)]"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span className="relative font-mono text-[0.46rem] leading-none font-bold tracking-[0.04em]">
        {tag}
      </span>
    </span>
  );
}

/** Keeps the extension visible when a long name is cut short. */
function FileName({ name }: Readonly<{ name: string }>) {
  const dot = name.lastIndexOf('.');
  const split = dot > 0 && name.length - dot <= 8;
  return (
    <span className="flex min-w-0 font-medium text-foreground">
      <span className="truncate">{split ? name.slice(0, dot) : name}</span>
      {split ? <span className="shrink-0">{name.slice(dot)}</span> : null}
    </span>
  );
}

/**
 * A file at a glance: type glyph, name and size, with optional detail and
 * actions. Read-only by itself; callers add controls through `actions`.
 */
export function FileChip({
  name,
  unnamedLabel = 'Unnamed file',
  mediaType,
  byteLength,
  detail,
  actions,
  className,
}: Readonly<{
  /** Undefined shows `unnamedLabel` quietly, for a name decided later. */
  name: string | undefined;
  unnamedLabel?: string;
  mediaType: string | undefined;
  byteLength?: number | undefined;
  detail?: ReactNode;
  actions?: ReactNode;
  className?: string;
}>) {
  return (
    <div
      data-slot="file-chip"
      className={cn(
        'flex h-13 min-w-0 items-center gap-3 rounded-lg border border-surface-ink/8 bg-card py-2 pr-1.5 pl-2.5 text-[0.8rem]',
        className,
      )}
    >
      <FileGlyph mediaType={mediaType} name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {name === undefined ? (
          <span className="truncate text-subtle-foreground italic">
            {unnamedLabel}
          </span>
        ) : (
          <FileName name={name} />
        )}
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[0.66rem] leading-none text-subtle-foreground tabular-nums">
          {byteLength === undefined ? null : (
            <span className="shrink-0">{formatByteLength(byteLength)}</span>
          )}
          {byteLength === undefined || detail === undefined ? null : (
            <span aria-hidden="true">·</span>
          )}
          {detail === undefined ? null : (
            <span className="min-w-0 truncate">{detail}</span>
          )}
        </span>
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center">{actions}</div>
      )}
    </div>
  );
}

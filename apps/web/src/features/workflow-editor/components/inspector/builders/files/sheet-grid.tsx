import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SHEET_PREVIEW_ROWS } from '../../../../model/inspector/files/sheet-preview';

const PLACEHOLDER_WIDTHS = [
  ['w-10', 'w-12', 'w-8'],
  ['w-14', 'w-6', 'w-10'],
  ['w-8', 'w-10', 'w-12'],
  ['w-12', 'w-8', 'w-6'],
  ['w-6', 'w-12', 'w-9'],
] as const;

/**
 * A few rows of a sheet in a fixed frame: column letters, the header row
 * lit and frozen above the data, then up to four rows. Without rows it draws
 * the same frame softly, so nothing moves when a test fills it; `notice`
 * says why it's empty. Columns that don't fit fade at the edge they scroll
 * from. `footer` sits under the frame, where Excel keeps its sheet tabs.
 */
export function SheetGrid({
  label,
  headerRow,
  headers,
  rows,
  caption,
  notice,
  stale = false,
  footer,
}: Readonly<{
  label: string;
  /** The header's row number, when the sheet position is known. */
  headerRow?: number | undefined;
  headers: readonly string[] | undefined;
  rows: readonly (readonly (string | undefined)[])[];
  caption: ReactNode;
  /** Drawn over the empty frame, such as a sheet with only its header row. */
  notice?: string | undefined;
  /** The rows came from before the latest edit. */
  stale?: boolean;
  footer?: ReactNode;
}>) {
  const columns = Math.max(3, headers?.length ?? 0);
  const template = `1.75rem repeat(${String(columns)}, minmax(4.5rem, 1fr))`;
  const hintId = useId();
  const { scroller, hidden } = useHiddenColumns(columns);
  const scrolls = hidden.start || hidden.end;
  return (
    <figure className="m-0 flex min-w-0 flex-col">
      <div className="relative min-w-0 overflow-hidden rounded-t-lg border border-surface-ink/8 bg-recess-ink/15">
        {stale ? (
          <span
            aria-hidden="true"
            className="absolute top-0.5 right-1 z-10 rounded-full border border-warning/30 bg-background/90 px-1.5 font-sans text-[0.6rem] leading-4 text-warning"
          >
            Before your edits
          </span>
        ) : null}
        <EdgeFade side="start" shown={hidden.start} />
        <EdgeFade side="end" shown={hidden.end} />
        {notice === undefined ? null : (
          // The caption says the same to screen readers.
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-12 bottom-0 z-[6] grid place-items-center"
          >
            <span className="rounded-full border border-surface-ink/10 bg-background/90 px-2.5 font-sans text-xs leading-6 text-muted-foreground">
              {notice}
            </span>
          </span>
        )}
        <div
          ref={scroller}
          role={headers === undefined ? undefined : 'table'}
          aria-label={headers === undefined ? undefined : label}
          aria-describedby={scrolls ? hintId : undefined}
          tabIndex={scrolls ? 0 : undefined}
          className="overflow-x-auto overscroll-x-contain [scrollbar-width:thin] focus-ring"
        >
          <div
            className="grid w-max min-w-full font-mono text-[0.68rem] leading-6"
            style={{ gridTemplateColumns: template }}
          >
            <span
              aria-hidden="true"
              className="border-r border-b border-surface-ink/7"
            />
            {Array.from({ length: columns }, (_, index) => (
              <span
                key={index}
                aria-hidden="true"
                className="border-b border-surface-ink/7 text-center text-[0.6rem] text-subtle-foreground"
              >
                {String.fromCharCode(65 + (index % 26))}
              </span>
            ))}
            <SheetRow
              header
              gutter={headerRow === undefined ? '' : String(headerRow)}
              cells={headers ?? []}
              columns={columns}
              placeholder={headers === undefined ? 0 : undefined}
            />
            {Array.from({ length: SHEET_PREVIEW_ROWS }, (_, index) => (
              <SheetRow
                key={index}
                gutter=""
                cells={rows[index] ?? []}
                columns={columns}
                placeholder={headers === undefined ? index + 1 : undefined}
              />
            ))}
          </div>
        </div>
      </div>
      <span id={hintId} className="sr-only">
        Scroll sideways to see more columns.
      </span>
      {footer}
      {/* Two lines are kept, so captions of different lengths don't shift the panel. */}
      <figcaption
        aria-live="polite"
        className="mt-1.5 min-h-10 text-xs leading-relaxed text-subtle-foreground"
      >
        {caption}
        {stale ? (
          <span className="sr-only">
            {' '}
            These rows are from before your latest edits; test again to refresh
            them.
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** Which edges hide columns: the frame fades there to show it scrolls. */
function useHiddenColumns(columns: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ start: false, end: false });
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = () => {
      const start = element.scrollLeft > 1;
      const end =
        element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setHidden((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end },
      );
    };
    measure();
    // The frame resizes with the panel, the grid with its columns.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild !== null)
      observer.observe(element.firstElementChild);
    element.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', measure);
    };
  }, [columns]);
  return { scroller, hidden };
}

/** A fade with a chevron where columns are hidden; the cut alone reads as the sheet's end. */
function EdgeFade({
  side,
  shown,
}: Readonly<{ side: 'start' | 'end'; shown: boolean }>) {
  const Chevron = side === 'start' ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-y-0 z-[5] flex w-12 items-center from-background from-35% to-transparent transition-opacity duration-200 motion-reduce:transition-none',
        side === 'start'
          ? 'left-0 justify-start bg-linear-to-r pl-1'
          : 'right-0 justify-end bg-linear-to-l pr-1',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <Chevron className="size-4 text-subtle-foreground" />
    </span>
  );
}

function SheetRow({
  header = false,
  gutter,
  cells,
  columns,
  placeholder,
}: Readonly<{
  header?: boolean;
  gutter: string;
  cells: readonly (string | undefined)[];
  columns: number;
  /** Draws soft bars instead of text, before there are any rows. */
  placeholder: number | undefined;
}>) {
  // Soft placeholder bars and unused rows are drawing, not table content.
  const real = placeholder === undefined && cells.length > 0;
  const cellRole = header ? 'columnheader' : 'cell';
  return (
    <div
      role={real ? 'row' : undefined}
      className={cn(
        'col-span-full grid grid-cols-subgrid',
        header &&
          'bg-action/[0.07] font-semibold text-accent-foreground shadow-[inset_0_-1.5px_0_color-mix(in_srgb,var(--action)_55%,transparent)]',
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-6 items-center justify-end border-r border-b border-surface-ink/6 pr-1 text-[0.6rem] text-subtle-foreground"
      >
        {gutter}
      </span>
      {Array.from({ length: columns }, (_, index) => {
        const width = PLACEHOLDER_WIDTHS[placeholder ?? 0]?.[index % 3];
        return (
          <span
            key={index}
            role={real && index < cells.length ? cellRole : undefined}
            className={cn(
              'flex h-6 min-w-0 items-center border-b border-surface-ink/6 px-2 not-last:border-r',
              !header && 'text-foreground/85',
            )}
          >
            {placeholder === undefined ? (
              <span className="truncate">{cells[index] ?? ''}</span>
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 rounded-full',
                  header ? 'bg-action/20' : 'bg-surface-ink/[0.07]',
                  index < 3 ? width : 'w-0',
                )}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}

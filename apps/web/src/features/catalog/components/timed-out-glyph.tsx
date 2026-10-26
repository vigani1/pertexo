import { cn } from '@/lib/utils';

/**
 * The Timed out path's mark: an hourglass whose sand has run through, drawn
 * in the thread glyphs' stroke. It takes the colour of its text.
 */
export function TimedOutGlyph({ className }: Readonly<{ className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid size-4 shrink-0 place-items-center',
        className,
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-full overflow-visible"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 1.8h9M3.5 14.2h9" />
        <path d="M4.8 1.8v1.4c0 2.1 3.2 3 3.2 4.8s-3.2 2.7-3.2 4.8v1.4M11.2 1.8v1.4c0 2.1-3.2 3-3.2 4.8s3.2 2.7 3.2 4.8v1.4" />
        <path
          d="M6.2 13.1 8 11.6l1.8 1.5Z"
          fill="currentColor"
          strokeWidth={1}
        />
      </svg>
    </span>
  );
}

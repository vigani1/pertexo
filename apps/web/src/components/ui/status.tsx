import type { ComponentProps, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// One glyph, one colour, one word for every status in the product. Features
// map their own enums onto these tones in their `model/`; this primitive knows
// nothing about runs, triggers or connections.
export type StatusTone =
  | 'live'
  | 'queued'
  | 'waiting'
  | 'success'
  | 'failure'
  | 'timeout'
  | 'attention'
  | 'canceled'
  | 'skipped'
  | 'neutral';

const statusVariants = cva(
  'inline-flex min-w-0 items-center gap-1.5 text-[0.8rem] leading-none font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        live: 'text-primary',
        queued: 'text-secondary',
        waiting: 'text-secondary',
        success: 'text-success',
        failure: 'text-destructive',
        timeout: 'text-destructive',
        attention: 'text-warning',
        canceled: 'text-subtle-foreground',
        skipped: 'text-subtle-foreground',
        neutral: 'text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function GlyphShape({ tone }: Readonly<{ tone: StatusTone }>) {
  switch (tone) {
    case 'live':
      return (
        <>
          <path d="M1.5 8h13" opacity={0.28} />
          <path
            d="M1.5 8h13"
            className="[stroke-dasharray:4_22] drop-shadow-[0_0_3px_currentColor] motion-safe:animate-thread-flow"
          />
        </>
      );
    case 'queued':
      return (
        <g fill="currentColor" stroke="none">
          <circle cx="3" cy="8" r="1.5" className="motion-safe:animate-bead" />
          <circle
            cx="8"
            cy="8"
            r="1.5"
            className="motion-safe:animate-bead [animation-delay:300ms]"
          />
          <circle
            cx="13"
            cy="8"
            r="1.5"
            className="motion-safe:animate-bead [animation-delay:600ms]"
          />
        </g>
      );
    case 'waiting':
      return <path d="M8 3.2a4.8 4.8 0 1 1-4.8 4.8" />;
    case 'success':
      return (
        <>
          <path d="M1.5 8h6" />
          <circle cx="11.2" cy="8" r="3.3" fill="currentColor" stroke="none" />
        </>
      );
    case 'failure':
      return <path d="M1.5 8h6.5M8 8l5.8-4.6M8 8h6.8M8 8l5.8 4.6" />;
    case 'timeout':
      return (
        <>
          <path d="M1.5 8h9.5" />
          <path d="M13.2 3.6v8.8" />
        </>
      );
    case 'attention':
      return (
        <>
          <path d="M1.5 8h5" />
          <path
            d="M9 8h6"
            className="[stroke-dasharray:1_2.4] motion-safe:animate-blink"
          />
        </>
      );
    case 'canceled':
      return <path d="M1.5 8h4.6M10 8h4.5M7 11.6 9.1 4.4" />;
    case 'skipped':
      return <path d="M1.5 8h13" strokeDasharray="2 2.6" />;
    case 'neutral':
      return <circle cx="8" cy="8" r="3.2" />;
  }
}

export function StatusGlyph({
  tone,
  className,
}: Readonly<{ tone: StatusTone; className?: string }>) {
  return (
    <span
      data-slot="status-glyph"
      aria-hidden="true"
      className={cn(
        'inline-grid size-4 shrink-0 place-items-center',
        tone === 'waiting' && 'motion-safe:animate-coil',
        className,
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-4 overflow-visible"
        {...strokeProps}
      >
        <GlyphShape tone={tone} />
      </svg>
    </span>
  );
}

/** A status word led by its glyph. The children are the accessible label. */
export function Status({
  tone,
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> &
  VariantProps<typeof statusVariants> & {
    tone: StatusTone;
    children?: ReactNode;
  }) {
  return (
    <span
      data-slot="status"
      data-tone={tone}
      className={cn(statusVariants({ tone }), className)}
      {...props}
    >
      <StatusGlyph tone={tone} />
      {children === undefined ? null : (
        <span className="min-w-0 truncate">{children}</span>
      )}
    </span>
  );
}

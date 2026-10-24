import { useState, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const disclosureVariants = cva('', {
  variants: {
    // A plain fold in running text, or a framed one standing on its own.
    look: {
      plain: '',
      framed: 'rounded-lg border border-border bg-surface-ink/[0.015]',
    },
  },
  defaultVariants: { look: 'plain' },
});

const summaryVariants = cva(
  'flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm outline-none select-none focus-ring [&::-webkit-details-marker]:hidden',
  {
    variants: {
      size: { xs: 'text-xs', sm: 'text-sm' },
      // Quiet folds hold detail; a link fold answers a question.
      tone: {
        quiet: 'text-subtle-foreground hover:text-foreground',
        strong: 'font-medium text-foreground/90 hover:text-foreground',
        link: 'text-accent-foreground hover:underline',
      },
      look: {
        plain: 'py-0.5',
        framed: 'w-full px-3 py-2.5 text-muted-foreground',
      },
    },
    defaultVariants: { size: 'sm', tone: 'quiet', look: 'plain' },
  },
);

/**
 * The one "show more" in the app: the page's chevron, turning as it opens,
 * on the browser's own disclosure, so find-in-page and the keyboard work.
 * `lazy` mounts the contents only once opened, for folds that read data.
 */
export function Disclosure({
  summary,
  children,
  appearance = {},
  lazy = false,
  defaultOpen = false,
  className,
  contentClassName,
}: Readonly<{
  summary: ReactNode;
  children: ReactNode;
  lazy?: boolean;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
  appearance?: VariantProps<typeof summaryVariants> &
    VariantProps<typeof disclosureVariants>;
}>) {
  const { size, tone, look } = appearance;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      data-slot="disclosure"
      open={defaultOpen || undefined}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className={cn(disclosureVariants({ look }), className)}
    >
      <summary className={summaryVariants({ size, tone, look })}>
        <ChevronRightIcon
          aria-hidden="true"
          // Only its own fold turns it, never an open fold around it.
          className="size-3.5 shrink-0 transition-transform duration-150 ease-unspool motion-reduce:transition-none [details[open]>summary>&]:rotate-90"
        />
        {summary}
      </summary>
      {lazy && !open ? null : (
        <div
          className={cn(
            look === 'framed' ? 'border-t border-border px-3 py-3' : 'mt-2',
            contentClassName,
          )}
        >
          {children}
        </div>
      )}
    </details>
  );
}

import { cva } from 'class-variance-authority';

// `primary` is the one filled action per screen; `default` is the tinted
// everyday action. Destructive intent keeps its own variant everywhere.
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-label font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-(--duration-quick) outline-none select-none max-sm:min-h-[var(--control-min-size,2.75rem)] max-sm:min-w-[var(--control-min-size,2.75rem)] focus-ring motion-safe:active:not-aria-[haspopup]:translate-y-px motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 data-pending:disabled:opacity-100 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          'bg-action font-semibold text-action-foreground hover:bg-action-hover',
        default:
          'border-border bg-select-raised text-foreground hover:bg-select-strong aria-expanded:bg-select-strong',
        outline:
          'border-border bg-select text-foreground hover:bg-select-raised aria-expanded:bg-select-raised',
        ghost:
          'text-muted-foreground hover:bg-select-raised hover:text-foreground aria-expanded:bg-select-raised aria-expanded:text-foreground',
        destructive:
          'bg-fail-soft text-destructive hover:bg-fail-soft hover:underline [--focus-ring-color:var(--destructive)]',
        chip: 'h-auto min-h-6.5 max-w-full gap-1.5 border-border bg-select-raised px-2 text-meta whitespace-normal text-foreground hover:bg-select-strong',
        link: 'inline-link h-auto px-0',
      },
      // Coarse pointers keep a 40px floor; phone controls use the shared
      // 44px minimum above unless their surface owns compact geometry.
      size: {
        default:
          'h-8.5 gap-2 px-3.5 pointer-coarse:h-10 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        xs: "h-6 gap-1 rounded-sm px-2 text-xs pointer-coarse:h-10 pointer-coarse:px-3 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded-sm px-2.5 text-meta pointer-coarse:h-10 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-10.5 gap-2 rounded-lg px-4.5 text-sm has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4',
        icon: 'size-8.5 pointer-coarse:size-10',
        'icon-xs':
          "size-6 rounded-sm pointer-coarse:size-10 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7 rounded-sm pointer-coarse:size-10',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

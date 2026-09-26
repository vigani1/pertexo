import { cva } from 'class-variance-authority';

// `primary` is the one filled action per screen; `default` is the tinted
// everyday action. Destructive intent keeps its own variant everywhere.
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 outline-none select-none focus-ring motion-safe:active:not-aria-[haspopup]:translate-y-px motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 data-pending:disabled:opacity-100 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Neon. Unavailable, it turns plain grey rather than a dim cyan;
        // while its request runs (data-pending) it keeps its light.
        primary:
          'neon disabled:border-transparent disabled:bg-white/9 disabled:bg-none disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100 aria-disabled:border-transparent aria-disabled:bg-white/9 aria-disabled:bg-none aria-disabled:text-muted-foreground aria-disabled:shadow-none aria-disabled:opacity-100 data-pending:disabled:neon',
        default:
          'border-action/25 bg-action/8 text-accent-foreground not-aria-disabled:hover:border-action/45 not-aria-disabled:hover:bg-action/13 aria-expanded:bg-action/13',
        outline:
          'border-white/8 bg-white/[0.035] text-muted-foreground not-aria-disabled:hover:border-white/14 not-aria-disabled:hover:bg-white/[0.06] not-aria-disabled:hover:text-foreground aria-expanded:bg-white/[0.06] aria-expanded:text-foreground',
        ghost:
          'text-muted-foreground not-aria-disabled:hover:bg-white/[0.05] not-aria-disabled:hover:text-foreground aria-expanded:bg-white/[0.05] aria-expanded:text-foreground',
        destructive:
          'border-destructive/30 bg-destructive/6 text-destructive hover:border-destructive/60 hover:bg-destructive/14 [--focus-ring-color:var(--destructive)]',
        link: 'inline-link h-auto px-0',
      },
      // On touch screens (pointer-coarse) every size is at least 40px, so
      // small icon and text buttons stay easy to hit with a thumb.
      size: {
        default:
          'h-9 gap-2 px-3.5 pointer-coarse:h-10 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        xs: "h-6 gap-1 rounded-sm px-2 text-xs pointer-coarse:h-10 pointer-coarse:px-3 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded-sm px-2.5 text-[0.8rem] pointer-coarse:h-10 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-11 gap-2 px-5 text-[0.95rem] has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4',
        icon: 'size-9 pointer-coarse:size-10',
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

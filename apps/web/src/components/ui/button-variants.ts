import { cva } from 'class-variance-authority';

export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent motion-safe:active:not-aria-[haspopup]:translate-y-px motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'border-primary/50 bg-primary/15 text-accent-foreground shadow-glow-primary hover:border-primary hover:bg-primary/20 hover:shadow-glow-primary-strong',
        outline:
          'border-border bg-background/60 text-foreground hover:border-primary/40 hover:bg-muted hover:text-primary aria-expanded:bg-muted aria-expanded:text-primary',
        secondary:
          'border-secondary/30 bg-secondary/10 text-secondary hover:border-secondary/60 hover:bg-secondary/15 aria-expanded:bg-secondary/15',
        ghost:
          'text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive:
          'border-destructive/35 bg-destructive/10 text-destructive hover:border-destructive/60 hover:bg-destructive/20 focus-visible:border-destructive focus-visible:ring-destructive/40',
        link: 'text-primary underline-offset-4 hover:underline',
        solid:
          'border-primary/60 bg-primary/20 text-accent-foreground shadow-glow-primary hover:border-primary/80 hover:bg-primary/25 hover:shadow-glow-primary-strong',
      },
      size: {
        default:
          'h-10 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-8',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

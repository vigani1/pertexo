import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// The small, presentational subset of the legacy shadcn Field composition.
// The caller owns validation and explicit control/description/error IDs.
export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn('flex flex-col gap-5', className)}
      {...props}
    />
  );
}

export function Field({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field"
      className={cn(
        'group/field flex min-w-0 flex-col gap-2 data-[invalid=true]:text-destructive',
        className,
      )}
      {...props}
    />
  );
}

export function FieldLabel({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn(
        'text-sm font-medium group-data-[disabled=true]/field:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-sm leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export function FieldError({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      role="alert"
      data-slot="field-error"
      className={cn('text-sm text-destructive', className)}
      {...props}
    />
  );
}

/**
 * Wraps a single control with Weft's validation thread: when `state` is
 * `invalid` the line under the control frays; `corrected` ties a brief knot
 * after a previously invalid value becomes valid. Purely visual — the caller
 * still sets `aria-invalid` and links its error with `aria-describedby`.
 */
export function FieldControl({
  state,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { state?: 'invalid' | 'corrected' | undefined }) {
  return (
    <div
      data-slot="field-control"
      data-state={state}
      className={cn('group/control relative min-w-0', className)}
      {...props}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-2.5 -bottom-px h-0.5 rounded-full opacity-0 group-data-[state=corrected]/control:bg-success group-data-[state=corrected]/control:motion-safe:animate-[field-tie_1.4s_ease-out_forwards] group-data-[state=invalid]/control:right-8 group-data-[state=invalid]/control:bg-linear-to-r group-data-[state=invalid]/control:from-destructive/15 group-data-[state=invalid]/control:to-destructive group-data-[state=invalid]/control:opacity-100"
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 22 16"
        className="pointer-events-none absolute right-2 -bottom-2 h-4 w-5.5 origin-left text-destructive opacity-0 group-data-[state=invalid]/control:opacity-100 group-data-[state=invalid]/control:motion-safe:animate-fray"
      >
        <path
          d="M0 8h7M7 8l13-6M7 8h15M7 8l13 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-2 -bottom-1.5 size-2.5 rounded-full bg-success opacity-0 group-data-[state=corrected]/control:motion-safe:animate-[knot-flash_1.4s_ease-out_forwards]"
      />
    </div>
  );
}

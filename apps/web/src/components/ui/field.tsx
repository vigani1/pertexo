import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The validation thread under a control: frayed, briefly knotted, or none. */
export type FieldThread = 'invalid' | 'corrected' | undefined;

// The small, presentational subset of the shadcn Field composition. The
// caller owns validation and explicit control/description/error IDs, or uses
// `LabelledField`, which links them.
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
        'text-[0.8rem] font-semibold text-foreground/85 group-data-[disabled=true]/field:opacity-50 group-data-[invalid=true]/field:text-destructive',
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
      className={cn(
        'text-[0.8rem] leading-relaxed text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function FieldError({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      role="alert"
      data-slot="field-error"
      className={cn('text-[0.8rem] text-destructive', className)}
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
}: ComponentProps<'div'> & { state?: FieldThread }) {
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

/** What `LabelledField` hands its control so the label and messages link up. */
export type LabelledControlProps = Readonly<{
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}>;

/**
 * The one labelled field: label (with an optional action beside it), the
 * control drawn by the caller with the returned accessibility props, the
 * validation thread, then any live feedback, the hint and the message.
 */
export function LabelledField({
  id,
  label,
  labelAction,
  description,
  error,
  thread,
  trailing,
  feedback,
  describedBy,
  className,
  children,
}: Readonly<{
  id: string;
  label: ReactNode;
  /** A small action on the label row, e.g. "Forgot?". */
  labelAction?: ReactNode;
  description?: ReactNode;
  error?: string | undefined;
  thread?: FieldThread;
  /** A control inside the input's right edge, e.g. show/hide. */
  trailing?: ReactNode;
  /** Live feedback between the control and its hint, e.g. a strength meter. */
  feedback?: ReactNode;
  /** Extra element IDs that describe the control, e.g. the meter's. */
  describedBy?: string | undefined;
  className?: string;
  children: (control: LabelledControlProps) => ReactNode;
}>) {
  const descriptionId =
    description === undefined ? undefined : `${id}-description`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const ariaDescribedBy =
    [describedBy, descriptionId, errorId].filter(Boolean).join(' ') ||
    undefined;
  return (
    <Field
      data-invalid={error === undefined ? undefined : true}
      className={className}
    >
      {labelAction === undefined ? (
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {labelAction}
        </div>
      )}
      <FieldControl
        state={thread}
        className={cn(trailing !== undefined && '[&_[data-slot=input]]:pr-11')}
      >
        {children({
          id,
          'aria-invalid': error !== undefined,
          'aria-describedby': ariaDescribedBy,
        })}
        {trailing === undefined ? null : (
          <div className="absolute inset-y-0 right-1 flex items-center">
            {trailing}
          </div>
        )}
      </FieldControl>
      {feedback}
      {description === undefined ? null : (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
      {error === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </Field>
  );
}

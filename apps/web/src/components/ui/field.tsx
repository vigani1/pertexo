import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

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
 * Holds a single control and anything drawn inside its edges (a show/hide
 * toggle, a unit). An invalid control marks itself with `aria-invalid`,
 * which draws its border in the error colour; the message sits below.
 */
export function FieldControl({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-control"
      className={cn('relative min-w-0', className)}
      {...props}
    />
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
 * control drawn by the caller with the returned accessibility props, then
 * any live feedback, the hint and the message.
 */
export function LabelledField({
  id,
  label,
  labelAction,
  description,
  error,
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
      className={cn(labelAction !== undefined && 'relative', className)}
    >
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldControl
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
      {labelAction === undefined ? null : (
        // Drawn on the label's row but reached after the control, so Tab
        // goes from one field to the next before any "Forgot?".
        <div className="absolute top-0 right-0 flex h-[1.2em] items-center text-[0.8rem]">
          {labelAction}
        </div>
      )}
    </Field>
  );
}
